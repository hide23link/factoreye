"""POST /api/ingest/readings のテスト。

docs/architecture.md §12 テスト のシナリオ（認証・不正ペイロード・
高頻度バッチ）を実装に合わせて踏襲。Alarm評価・dedupeはSprint 4で追加。
"""
import asyncio
import logging
import time
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

import app.api.ingest as ingest_module
import app.ingest_buffer as ingest_buffer
import app.main as main_module
from app.config import AuthMode, IngestAuth, settings
from app.db.models import Reading
from app.db.session import engine
from app.ingest_buffer import IngestBuffer, PendingReading, buffer, flush_once
from app.main import app, start_and_stop

VALID_HEADERS = {"X-API-Key": settings.ingest_api_key}


async def _create_sensor(client: httpx.AsyncClient, ingest_key: str) -> str:
    resp = await client.post(
        "/api/sensors",
        json={"name": f"sensor-{ingest_key}", "ingestKey": ingest_key, "unit": "C"},
    )
    assert resp.status_code == 201
    return str(resp.json()["id"])


async def test_invalid_api_key_returns_401(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={"X-API-Key": "invalid"},
        json={"ingestKey": "sensor-1", "value": 42},
    )
    assert resp.status_code == 401


async def test_non_ascii_api_key_returns_401(client: httpx.AsyncClient) -> None:
    # 一定時間の比較でも、ASCII 以外のキーで 500 にならない
    resp = await client.post(
        "/api/ingest/readings",
        headers={b"X-API-Key": "キー".encode()},
        json={"ingestKey": "sensor-1", "value": 42},
    )
    assert resp.status_code == 401


async def test_malformed_payload_does_not_crash_server(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content="invalid json {{{",
    )
    assert resp.status_code == 400
    assert (await client.get("/health")).status_code == 200


async def test_ingest_unknown_ingest_key_returns_404(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "does-not-exist", "value": 1.0},
    )
    assert resp.status_code == 404


async def test_ingest_missing_ingest_key_returns_400(client: httpx.AsyncClient) -> None:
    # ingestKey自体が無い（Pydanticのバリデーションエラー経路）
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"value": 1.0},
    )
    assert resp.status_code == 400


async def test_ingest_neither_value_nor_readings_returns_400(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "empty-payload-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "empty-payload-sensor"},
    )
    assert resp.status_code == 400


async def test_ingest_disabled_sensor_returns_403(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "disabled-ingest-sensor")
    disable = await client.put(f"/api/sensors/{sensor_id}", json={"enabled": False})
    assert disable.status_code == 200

    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "disabled-ingest-sensor", "value": 1.0},
    )
    assert resp.status_code == 403


async def test_ingest_single_reading_persists_after_flush(client: httpx.AsyncClient) -> None:
    sensor_id = await _create_sensor(client, "single-reading-sensor")

    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "single-reading-sensor", "value": 23.5},
    )
    assert resp.status_code == 202
    assert resp.json()["accepted"] == 1

    await flush_once()

    readings = await client.get(f"/api/sensors/{sensor_id}/readings")
    assert readings.status_code == 200
    body = readings.json()
    assert body["total"] == 1
    assert body["readings"][0]["value"] == 23.5


async def test_ingest_batch_handles_many_readings(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "batch-sensor")
    readings = [{"value": i * 0.1} for i in range(1000)]

    start = time.monotonic()
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "batch-sensor", "readings": readings},
    )
    elapsed = time.monotonic() - start

    assert resp.status_code == 202
    assert resp.json()["accepted"] == 1000
    assert elapsed < 5.0

    flushed = await flush_once()
    assert flushed == 1000


async def test_batch_with_several_values_keeps_every_value(client: httpx.AsyncClient) -> None:
    # 回帰: 測定値の主キーは (sensor_id, recorded_at)。1 回の送信内の値が同じ時刻のままだと、
    # 2 件目以降が主キー重複になる。送信内の i 番目の値は i マイクロ秒ずらして、全部残す
    sensor_id = await _create_sensor(client, "same-request-sensor")
    values = [1.0, 2.0, 3.0, 4.0, 5.0]
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "same-request-sensor", "readings": [{"value": v} for v in values]},
    )
    assert resp.status_code == 202

    await flush_once()

    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == len(values)
    # 新しい順に返る。送った順（古い→新しい）に時刻が進んでいる
    assert [r["value"] for r in body["readings"]] == list(reversed(values))
    times = [r["recordedAt"] for r in body["readings"]]
    assert len(set(times)) == len(values)


async def test_flush_ignores_same_sensor_and_time_instead_of_failing(
    client: httpx.AsyncClient,
) -> None:
    # 別々の送信が同じマイクロ秒に重なる、または flush を再試行して同じ値が二度届いても、
    # 主キー重複でバッチ全体が失敗しない（他のセンサーの値も書ける）
    sensor_id = await _create_sensor(client, "duplicate-time-sensor")
    other_id = await _create_sensor(client, "duplicate-time-other")
    at = datetime.now(UTC)
    for sid, value in (
        (sensor_id, 1.0),
        (sensor_id, 2.0),  # 同じセンサー・同じ時刻
        (other_id, 7.0),
    ):
        await buffer.add(PendingReading(sensor_id=UUID(sid), value=value, recorded_at=at))

    # 戻り値は、書いた件数（同じセンサー・同じ時刻は 1 件に数える）
    assert await flush_once() == 2

    first = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    other = (await client.get(f"/api/sensors/{other_id}/readings")).json()
    assert first["total"] == 1
    assert first["readings"][0]["value"] == 2.0  # 後から来た値で上書き（最後の 1 件が残る）
    assert other["total"] == 1


async def test_later_flush_overwrites_same_sensor_and_time(client: httpx.AsyncClient) -> None:
    """別々の flush で同じ (センサー, 時刻) が来たら、後の値で上書きする（L-1 の決定）。"""
    sensor_id = await _create_sensor(client, "overwrite-sensor")
    at = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=5)
    await buffer.add(PendingReading(sensor_id=UUID(sensor_id), value=1.0, recorded_at=at))
    await flush_once()
    await buffer.add(PendingReading(sensor_id=UUID(sensor_id), value=5.0, recorded_at=at))
    await flush_once()
    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1
    assert body["readings"][0]["value"] == 5.0


async def _count_readings(sensor_id: str) -> int:
    async with AsyncSession(engine) as session:
        result = await session.exec(
            select(func.count(1)).select_from(Reading).where(Reading.sensor_id == UUID(sensor_id))
        )
        return int(result.one())


async def test_flush_handles_more_readings_than_one_statement_can_hold(
    client: httpx.AsyncClient,
) -> None:
    # 回帰: 全行を 1 つの INSERT 文に入れると、asyncpg のパラメータ上限（32,767）を超える
    # 1 万件余りで失敗し続け、バッファが減らず取り込み全体が止まる。区切って全件書く
    sensor_id = await _create_sensor(client, "huge-flush-sensor")
    t0 = datetime.now(UTC)
    total = 11_000  # 1 文なら 33,000 パラメータで上限超え
    for i in range(total):
        await buffer.add(
            PendingReading(
                sensor_id=UUID(sensor_id),
                value=float(i),
                recorded_at=t0 + timedelta(microseconds=i),
            )
        )

    assert await flush_once() == total

    assert await _count_readings(sensor_id) == total
    assert await flush_once() == 0  # バッファは空になっている（詰まっていない）


async def test_close_requests_to_the_same_sensor_never_share_a_time(
    client: httpx.AsyncClient,
) -> None:
    # 1,000 件の送信の直後（1 ms 未満）に、同じセンサーへ別の送信が来ても、どの値も失われない。
    # 送信内の値は 1 µs ずつ進めるため、後の送信の時刻が前の送信の途中に重なりうる。
    # センサーごとに前の最後の時刻を覚えて、後の送信はその後ろから始める
    sensor_id = await _create_sensor(client, "close-requests-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "close-requests-sensor", "readings": [{"value": 1.0}] * 1000},
    )
    assert resp.status_code == 202
    for _ in range(3):
        resp = await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={"ingestKey": "close-requests-sensor", "value": 2.0},
        )
        assert resp.status_code == 202

    assert await flush_once() == 1003

    assert await _count_readings(sensor_id) == 1003


async def test_flush_once_with_empty_buffer_returns_zero() -> None:
    # 何も溜まっていない状態でflushが呼ばれても0件として正常終了する
    assert await flush_once() == 0


async def test_flush_failure_puts_back_readings_for_retry(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # commit 前に失敗しても値は消えず、次の flush で書かれる
    sensor_id = await _create_sensor(client, "retry-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "retry-sensor", "value": 7.0},
    )
    assert resp.status_code == 202

    async def _fail(*_args: object, **_kwargs: object) -> None:
        raise RuntimeError("db unavailable")

    with monkeypatch.context() as m:
        m.setattr(ingest_buffer, "evaluate_alarms", _fail)
        with pytest.raises(RuntimeError):
            await flush_once()

    assert await flush_once() == 1
    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1
    assert body["readings"][0]["value"] == 7.0


async def test_flush_drops_readings_of_deleted_sensor_without_blocking_others(
    client: httpx.AsyncClient,
) -> None:
    deleted_id = await _create_sensor(client, "deleted-before-flush")
    kept_id = await _create_sensor(client, "kept-sensor")
    for key in ("deleted-before-flush", "kept-sensor"):
        resp = await client.post(
            "/api/ingest/readings", headers=VALID_HEADERS, json={"ingestKey": key, "value": 1.0}
        )
        assert resp.status_code == 202
    assert (await client.delete(f"/api/sensors/{deleted_id}")).status_code in (200, 204)

    assert await flush_once() == 1
    assert await flush_once() == 0
    body = (await client.get(f"/api/sensors/{kept_id}/readings")).json()
    assert body["total"] == 1


async def test_put_back_keeps_order_and_drops_oldest_over_capacity(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    monkeypatch.setattr(ingest_buffer, "MAX_PENDING_READINGS", 3)
    buf = IngestBuffer()
    sensor_id = uuid4()

    def reading(value: float) -> PendingReading:
        return PendingReading(sensor_id=sensor_id, value=value, recorded_at=datetime.now(UTC))

    await buf.add(reading(3.0))
    await buf.add(reading(4.0))
    await buf.put_back([reading(1.0), reading(2.0)])

    assert [p.value for p in await buf.take_all()] == [2.0, 3.0, 4.0]


async def test_shutdown_flushes_remaining_readings(client: httpx.AsyncClient) -> None:
    # 停止時、まだ DB に書いていない値を書いてから終了する
    sensor_id = await _create_sensor(client, "shutdown-sensor")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "shutdown-sensor", "value": 9.0},
    )
    assert resp.status_code == 202

    async with start_and_stop(app):
        pass

    body = (await client.get(f"/api/sensors/{sensor_id}/readings")).json()
    assert body["total"] == 1


async def test_shutdown_continues_when_final_flush_fails(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    async def _fail() -> int:
        raise RuntimeError("db unavailable")

    monkeypatch.setattr(main_module, "flush_once", _fail)
    async with start_and_stop(app):
        pass


async def test_non_utf8_body_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=b"\xff\xfe\xfa",
    )
    assert resp.status_code == 400


@pytest.mark.parametrize("bad", ["NaN", "Infinity", "-Infinity"])
async def test_non_finite_value_returns_400(client: httpx.AsyncClient, bad: str) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=f'{{"ingestKey": "k", "value": {bad}}}'.encode(),
    )
    assert resp.status_code == 400


async def test_too_many_readings_returns_400(client: httpx.AsyncClient) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "k", "readings": [{"value": 1}] * 1001},
    )
    assert resp.status_code == 400


async def test_exactly_max_readings_is_accepted(client: httpx.AsyncClient) -> None:
    await _create_sensor(client, "max-batch")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "max-batch", "readings": [{"value": 1}] * 1000},
    )
    assert resp.status_code == 202


async def test_non_finite_value_inside_readings_returns_400(
    client: httpx.AsyncClient,
) -> None:
    resp = await client.post(
        "/api/ingest/readings",
        headers={**VALID_HEADERS, "Content-Type": "application/json"},
        content=b'{"ingestKey": "k", "readings": [{"value": 1}, {"value": NaN}]}',
    )
    assert resp.status_code == 400


# ---- INGEST_AUTH（キーなしの取り込み） ----


async def test_missing_api_key_returns_401_by_default(client: httpx.AsyncClient) -> None:
    """既定（INGEST_AUTH=key）では、ヘッダーなしは 401（今までどおり）。"""
    resp = await client.post(
        "/api/ingest/readings", json={"ingestKey": "no-header-sensor", "value": 1.0}
    )
    assert resp.status_code == 401


async def test_ingest_auth_off_accepts_requests_without_key(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    await _create_sensor(client, "keyless-sensor")

    resp = await client.post(
        "/api/ingest/readings", json={"ingestKey": "keyless-sensor", "value": 21.5}
    )
    assert resp.status_code == 202
    assert resp.json()["accepted"] == 1


async def test_ingest_auth_off_ignores_wrong_key(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """キーなしにしても、古い機器が送ってくるヘッダーで拒否しない（無視する）。"""
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    await _create_sensor(client, "keyless-with-header")

    resp = await client.post(
        "/api/ingest/readings",
        headers={"X-API-Key": "anything"},
        json={"ingestKey": "keyless-with-header", "value": 1.0},
    )
    assert resp.status_code == 202


async def test_ingest_auth_off_still_rejects_unknown_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """キーなしでも、センサーの ingestKey が未登録なら 404（識別は ingestKey で続く）。"""
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    resp = await client.post(
        "/api/ingest/readings", json={"ingestKey": "unknown-keyless", "value": 1.0}
    )
    assert resp.status_code == 404


async def test_ingest_auth_off_does_not_open_other_apis(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """INGEST_AUTH=off は取り込みだけの設定。ほかの API の認証は変わらない（SaaS の JWT）。"""
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    resp = await client.get("/api/sensors")
    assert resp.status_code == 401


@pytest.mark.parametrize(
    ("auth_mode", "ingest_auth", "requires_key"),
    [
        (AuthMode.DISABLED, IngestAuth.KEY, True),
        (AuthMode.DISABLED, IngestAuth.OFF, False),
        (AuthMode.MULTI_TENANT, IngestAuth.KEY, False),
        (AuthMode.MULTI_TENANT, IngestAuth.OFF, False),
    ],
)
def test_ingest_requires_key_matrix(
    monkeypatch: pytest.MonkeyPatch,
    auth_mode: AuthMode,
    ingest_auth: IngestAuth,
    requires_key: bool,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", auth_mode)
    monkeypatch.setattr(settings, "ingest_auth", ingest_auth)
    assert settings.ingest_requires_key is requires_key


@pytest.mark.parametrize(
    ("auth_mode", "ingest_auth", "warns"),
    [
        (AuthMode.DISABLED, IngestAuth.OFF, True),
        (AuthMode.DISABLED, IngestAuth.KEY, False),
        (AuthMode.MULTI_TENANT, IngestAuth.OFF, False),  # SaaS では INGEST_AUTH を使わない
    ],
)
async def test_startup_warns_only_when_keyless_ingest_is_active(
    monkeypatch: pytest.MonkeyPatch,
    caplog: pytest.LogCaptureFixture,
    auth_mode: AuthMode,
    ingest_auth: IngestAuth,
    warns: bool,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", auth_mode)
    monkeypatch.setattr(settings, "ingest_auth", ingest_auth)
    with caplog.at_level(logging.WARNING, logger="app.main"):
        async with start_and_stop(app):
            pass
    assert any("INGEST_AUTH=off" in r.getMessage() for r in caplog.records) is warns


# ---- INGEST_AUTO_CREATE（未登録の ingestKey のセンサーを自動で作る） ----


async def _sensors(client: httpx.AsyncClient) -> list[dict[str, object]]:
    return list((await client.get("/api/sensors")).json())


async def _ingest(
    client: httpx.AsyncClient,
    key: str,
    value: float = 1.0,
    /,
    *,
    name: str | None = None,
    unit: str | None = None,
) -> int:
    """取り込みを 1 回送って、ステータスコードを返す。name・unit は、自動で作るときに使う項目。"""
    body: dict[str, object] = {"ingestKey": key, "value": value}
    if name is not None:
        body["name"] = name
    if unit is not None:
        body["unit"] = unit
    return (await client.post("/api/ingest/readings", json=body)).status_code


def _auto_create_on(monkeypatch: pytest.MonkeyPatch, max_sensors: int = 100) -> None:
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    monkeypatch.setattr(settings, "ingest_auto_create", True)
    monkeypatch.setattr(settings, "ingest_auto_create_max_sensors", max_sensors)


async def test_unknown_key_is_404_and_creates_nothing_by_default(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """既定（INGEST_AUTO_CREATE=off）では、未登録の ingestKey は 404 で、センサーは増えない。"""
    monkeypatch.setattr(settings, "ingest_auth", IngestAuth.OFF)
    assert await _ingest(client, "typo-key", name="x", unit="C") == 404
    assert await _sensors(client) == []


async def test_auto_create_makes_sensor_with_name_and_unit(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    resp = await client.post(
        "/api/ingest/readings",
        json={"ingestKey": "atom-b665-temp", "value": 26.5, "name": "ATOM 温度", "unit": "℃"},
    )
    assert resp.status_code == 202
    sensors = await _sensors(client)
    assert len(sensors) == 1
    sensor = sensors[0]
    assert sensor["name"] == "ATOM 温度"
    assert (sensor["ingestKey"], sensor["unit"]) == ("atom-b665-temp", "℃")
    assert sensor["enabled"] is True
    # 値も保存される（作ったあと、そのまま取り込む）
    await flush_once()
    readings = (await client.get(f"/api/sensors/{sensors[0]['id']}/readings")).json()
    assert [r["value"] for r in readings["readings"]] == [26.5]


async def test_auto_create_defaults_name_to_key_and_unit_to_dash(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    resp = await client.post("/api/ingest/readings", json={"ingestKey": "plain-key", "value": 1.0})
    assert resp.status_code == 202
    sensor = (await _sensors(client))[0]
    assert (sensor["name"], sensor["unit"]) == ("plain-key", "-")


async def test_auto_create_does_not_overwrite_registered_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """登録済みのセンサーは、本文の name・unit で上書きしない。"""
    _auto_create_on(monkeypatch)
    await _create_sensor(client, "registered-key")  # 名前は sensor-registered-key、単位は C
    resp = await client.post(
        "/api/ingest/readings",
        json={"ingestKey": "registered-key", "value": 1.0, "name": "別の名前", "unit": "kg"},
    )
    assert resp.status_code == 202
    sensors = await _sensors(client)
    assert len(sensors) == 1
    assert (sensors[0]["name"], sensors[0]["unit"]) == ("sensor-registered-key", "C")


async def test_auto_create_appends_key_when_name_is_taken(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    for key in ("first-key", "second-key"):
        resp = await client.post(
            "/api/ingest/readings", json={"ingestKey": key, "value": 1.0, "name": "温度"}
        )
        assert resp.status_code == 202
    names = sorted(str(s["name"]) for s in await _sensors(client))
    assert names == ["温度", "温度 (second-key)"]


@pytest.mark.parametrize(
    "key",
    [
        "with space", "日本語", "a/b", "semi;colon", "x" * 65, 'q"uote',
        "abc\n", "abc\r\n", "１２", "a\x00b",
    ],
)
async def test_auto_create_rejects_bad_keys(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, key: str
) -> None:
    _auto_create_on(monkeypatch)
    resp = await client.post("/api/ingest/readings", json={"ingestKey": key, "value": 1.0})
    assert resp.status_code == 400
    assert await _sensors(client) == []


async def test_auto_create_stops_at_the_limit(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch, max_sensors=2)
    for key in ("a-1", "a-2"):
        assert await _ingest(client, key) == 202
    assert await _ingest(client, "a-3") == 403
    assert len(await _sensors(client)) == 2
    # 上限に達しても、登録済みのセンサーへの送信は続けられる
    assert await _ingest(client, "a-1", 2.0) == 202


async def test_auto_create_does_not_revive_a_disabled_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    sensor_id = await _create_sensor(client, "disabled-key")
    disabled = await client.put(f"/api/sensors/{sensor_id}", json={"enabled": False})
    assert disabled.status_code == 200
    assert await _ingest(client, "disabled-key") == 403
    assert len(await _sensors(client)) == 1


async def test_auto_create_recreates_a_deleted_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """削除したセンサーも、次の送信で、また作られる（止めるなら INGEST_AUTO_CREATE を off）。"""
    _auto_create_on(monkeypatch)
    await client.post("/api/ingest/readings", json={"ingestKey": "comes-back", "value": 1.0})
    sensor = (await _sensors(client))[0]
    assert (await client.delete(f"/api/sensors/{sensor['id']}")).status_code == 204
    assert await _sensors(client) == []
    assert await _ingest(client, "comes-back") == 202
    assert len(await _sensors(client)) == 1


async def test_auto_create_is_ignored_in_multi_tenant(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SaaS では、ingestKey だけでは、どのワークスペースかが決まらないので、自動で作らない。"""
    _auto_create_on(monkeypatch)
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    resp = await client.post("/api/ingest/readings", json={"ingestKey": "saas-key", "value": 1.0})
    assert resp.status_code == 404


async def test_auto_create_with_key_auth_still_requires_the_key(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """INGEST_AUTH=key のままなら、自動で作る前に、キーを確かめる（キーなしでは作れない）。"""
    monkeypatch.setattr(settings, "ingest_auto_create", True)
    resp = await client.post("/api/ingest/readings", json={"ingestKey": "no-key", "value": 1.0})
    assert resp.status_code == 401
    assert await _sensors(client) == []
    resp = await client.post(
        "/api/ingest/readings", headers=VALID_HEADERS, json={"ingestKey": "with-key", "value": 1.0}
    )
    assert resp.status_code == 202


async def test_auto_create_concurrent_requests_make_one_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同じ新しい ingestKey が同時に来ても、センサーは 1 つだけ作る（500 にならない）。"""
    _auto_create_on(monkeypatch)
    codes = await asyncio.gather(*[_ingest(client, "same-key", float(i)) for i in range(5)])
    assert list(codes) == [202] * 5
    assert len(await _sensors(client)) == 1


async def test_auto_create_startup_warning(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _auto_create_on(monkeypatch, max_sensors=7)
    with caplog.at_level(logging.WARNING, logger="app.main"):
        async with start_and_stop(app):
            pass
    messages = [r.getMessage() for r in caplog.records]
    assert any("INGEST_AUTO_CREATE=on" in m and "7" in m for m in messages)


async def test_auto_create_warns_that_multi_tenant_ignores_it(
    monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    _auto_create_on(monkeypatch)
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    with caplog.at_level(logging.WARNING, logger="app.main"):
        async with start_and_stop(app):
            pass
    assert any("SaaS" in r.getMessage() and "無視" in r.getMessage() for r in caplog.records)


async def test_auto_create_cleans_name_and_unit(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """名前・単位は、拒否せずに整える（制御文字・NUL・RTL を除き、空白を削り、長さを切る）。"""
    _auto_create_on(monkeypatch)
    dirty_name = "  温度\n\x00\u202e計\r  "
    assert await _ingest(client, "clean-1", name=dirty_name, unit="\u202a℃\n") == 202
    sensor = (await _sensors(client))[0]
    assert (sensor["name"], sensor["unit"]) == ("温度計", "℃")


async def test_auto_create_falls_back_to_defaults_for_blank_text(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    assert await _ingest(client, "blank-1", name="  \n ", unit="\x00") == 202
    sensor = (await _sensors(client))[0]
    assert (sensor["name"], sensor["unit"]) == ("blank-1", "-")


async def test_auto_create_truncates_long_name_and_unit(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    assert await _ingest(client, "long-1", name="あ" * 150, unit="u" * 40) == 202
    sensor = (await _sensors(client))[0]
    assert (sensor["name"], sensor["unit"]) == ("あ" * 100, "u" * 20)


async def test_bad_name_or_unit_never_breaks_a_registered_sensor(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """登録済みのセンサーへの送信は、name・unit が変でも、400 にならない（無視する）。"""
    _auto_create_on(monkeypatch)
    await _create_sensor(client, "old-key")
    extras: list[dict[str, str]] = [
        {"name": ""},
        {"unit": "u" * 21},
        {"name": "x" * 101},
        {"name": "\x00"},
    ]
    for extra in extras:
        assert await _ingest(client, "old-key", **extra) == 202


async def test_auto_create_log_cannot_be_forged(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, caplog: pytest.LogCaptureFixture
) -> None:
    """name に改行を入れても、ログは 1 行のまま（偽のログ行を作らせない）。"""
    _auto_create_on(monkeypatch)
    with caplog.at_level(logging.WARNING, logger="app.api.ingest"):
        assert await _ingest(client, "log-1", name="a\nWARNING fake line") == 202
    messages = [r.getMessage() for r in caplog.records if "auto-created" in r.getMessage()]
    assert len(messages) == 1 and "\n" not in messages[0]


async def test_auto_create_name_collision_with_long_names(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """100 文字ちょうどの名前が重なっても、(ingestKey) を残して、重ならない名前で作る。"""
    _auto_create_on(monkeypatch)
    name = "あ" * 100
    assert await _ingest(client, "dup-a", name=name) == 202
    assert await _ingest(client, "dup-b", name=name) == 202
    names = [str(s["name"]) for s in await _sensors(client)]
    assert len(set(names)) == 2 and all(len(n) <= 100 for n in names)
    assert any(n.endswith("(dup-b)") for n in names)


async def test_auto_create_name_collision_with_the_suffixed_name(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """「T (k2)」という名前が、すでにあっても、k2 のセンサーは作れる（次の候補を使う）。"""
    _auto_create_on(monkeypatch)
    assert await _ingest(client, "other", name="T (k2)") == 202
    assert await _ingest(client, "first", name="T") == 202
    # 「T」も「T (k2)」も使用済みなので、3 つ目の候補（ingestKey）を使う
    assert await _ingest(client, "k2", name="T") == 202
    assert len({str(s["name"]) for s in await _sensors(client)}) == 3


async def test_auto_create_same_name_different_keys_concurrently(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同じ名前で、別の ingestKey が同時に来ても、全部作れる（409 にならない）。"""
    _auto_create_on(monkeypatch)
    codes = await asyncio.gather(
        *[_ingest(client, f"same-name-{i}", name="温度") for i in range(10)]
    )
    assert list(codes) == [202] * 10
    assert len(await _sensors(client)) == 10


async def test_auto_create_limit_holds_under_concurrency(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同時に大量に来ても、上限（ここでは 3）を超えて作らない。"""
    _auto_create_on(monkeypatch, max_sensors=3)
    codes = await asyncio.gather(*[_ingest(client, f"race-{i}") for i in range(30)])
    assert sorted(codes).count(202) == 3 and sorted(codes).count(403) == 27
    assert len(await _sensors(client)) == 3


async def test_auto_create_with_readings_array(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _auto_create_on(monkeypatch)
    readings = [{"value": 1.0}, {"value": 2.0}]
    body = {"ingestKey": "batch-1", "name": "バッチ", "unit": "個", "readings": readings}
    resp = await client.post("/api/ingest/readings", json=body)
    assert resp.status_code == 202 and resp.json()["accepted"] == 2
    assert (await _sensors(client))[0]["name"] == "バッチ"


# ---- INGEST_DEVICE_TIME（機器が付けた測定時刻を使う） ----


async def _stored_times(sensor_id: str) -> list[datetime]:
    await flush_once()
    async with AsyncSession(engine) as session:
        rows = await session.exec(
            select(Reading.recorded_at)
            .where(Reading.sensor_id == UUID(sensor_id))
            .order_by(col(Reading.recorded_at))
        )
        return list(rows.all())


async def test_device_time_is_ignored_by_default(client: httpx.AsyncClient) -> None:
    """既定（off）では、timestamp を付けても受信時刻で保存する（従来どおり）。"""
    sensor_id = await _create_sensor(client, "dt-default")
    sent = datetime.now(UTC) - timedelta(hours=1)
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "dt-default", "value": 1, "timestamp": sent.isoformat()},
    )
    assert resp.status_code == 202
    (stored,) = await _stored_times(sensor_id)
    assert stored > datetime.now(UTC) - timedelta(minutes=1)


async def test_device_time_is_used_when_on(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "dt-on")
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
    readings = [
        {"value": i, "timestamp": (base + timedelta(seconds=i)).isoformat()} for i in range(5)
    ]
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "dt-on", "readings": readings},
    )
    assert resp.status_code == 202
    assert await _stored_times(sensor_id) == [base + timedelta(seconds=i) for i in range(5)]


async def test_device_time_accepts_unix_seconds(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "dt-unix")
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "dt-unix", "value": 1, "timestamp": int(base.timestamp())},
    )
    assert resp.status_code == 202
    assert await _stored_times(sensor_id) == [base]


async def test_device_time_resend_does_not_duplicate(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """同じ時刻の値を送り直しても、二重に保存しない（通信失敗後の再送のため）。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "dt-resend")
    body = {
        "ingestKey": "dt-resend",
        "value": 1,
        "timestamp": (datetime.now(UTC) - timedelta(seconds=5)).isoformat(),
    }
    for _ in range(2):
        resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=body)
        assert resp.status_code == 202
        await flush_once()
    assert len(await _stored_times(sensor_id)) == 1


async def test_device_time_mixed_with_server_time(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """timestamp の無い値は受信時刻のまま、付いた値は機器の時刻で保存する。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "dt-mixed")
    sent = datetime.now(UTC).replace(microsecond=0) - timedelta(hours=1)
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "ingestKey": "dt-mixed",
            "readings": [{"value": 1, "timestamp": sent.isoformat()}, {"value": 2}, {"value": 3}],
        },
    )
    assert resp.status_code == 202
    times = await _stored_times(sensor_id)
    assert times[0] == sent
    assert len(times) == 3
    assert times[2] - times[1] == timedelta(microseconds=1)
    assert times[1] > datetime.now(UTC) - timedelta(minutes=1)


@pytest.mark.parametrize(
    "offset",
    [timedelta(seconds=11), timedelta(days=-31)],
    ids=["future", "too-old"],
)
async def test_device_time_out_of_range_returns_400(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, offset: timedelta
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "dt-range")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "ingestKey": "dt-range",
            "readings": [
                {"value": 1},
                {"value": 2, "timestamp": (datetime.now(UTC) + offset).isoformat()},
            ],
        },
    )
    assert resp.status_code == 400
    assert await _stored_times(sensor_id) == []  # 全体を受け付けない


async def test_device_time_without_time_zone_returns_400(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    await _create_sensor(client, "dt-naive")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "dt-naive", "value": 1, "timestamp": "2026-10-30T12:00:00"},
    )
    assert resp.status_code == 400


# ---- 複数センサーを 1 回で送る（sensors） ----


async def _count(sensor_id: str) -> int:
    await flush_once()
    async with AsyncSession(engine) as session:
        return (
            await session.exec(
                select(func.count())
                .select_from(Reading)
                .where(Reading.sensor_id == UUID(sensor_id))
            )
        ).one()


async def test_multi_sensor_request_saves_every_sensor(client: httpx.AsyncClient) -> None:
    ids = {key: await _create_sensor(client, key) for key in ("m-a", "m-b", "m-c")}
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "sensors": [
                {"ingestKey": "m-a", "value": 1},
                {"ingestKey": "m-b", "readings": [{"value": 2}, {"value": 3}]},
                {"ingestKey": "m-c", "readings": [{"value": 4}] * 3},
            ]
        },
    )
    assert resp.status_code == 202
    assert resp.json() == {"accepted": 6, "rejected": []}
    assert [await _count(ids[k]) for k in ("m-a", "m-b", "m-c")] == [1, 2, 3]


async def test_multi_sensor_request_keeps_going_past_a_bad_sensor(
    client: httpx.AsyncClient,
) -> None:
    """未登録・無効・値なしのセンサーは rejected に出し、ほかは受け付ける。"""
    good = await _create_sensor(client, "mp-good")
    off = await _create_sensor(client, "mp-off")
    resp = await client.put(f"/api/sensors/{off}", json={"enabled": False})
    assert resp.status_code == 200
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "sensors": [
                {"ingestKey": "mp-nope", "value": 1},
                {"ingestKey": "mp-off", "value": 1},
                {"ingestKey": "mp-good", "value": 1},
                {"ingestKey": "mp-good", "readings": []},
            ]
        },
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["accepted"] == 1
    assert [(r["ingestKey"], r["status"]) for r in body["rejected"]] == [
        ("mp-nope", 404),
        ("mp-off", 403),
        ("mp-good", 400),
    ]
    assert await _count(good) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"ingestKey": "x", "value": 1, "sensors": [{"ingestKey": "x", "value": 1}]},
        {"sensors": [{"value": 1}]},
        {"value": 1},
    ],
    ids=["both-forms", "sensor-without-key", "neither-form"],
)
async def test_multi_sensor_bad_shape_returns_400(
    client: httpx.AsyncClient, body: dict[str, object]
) -> None:
    resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=body)
    assert resp.status_code == 400


async def test_multi_sensor_total_limit_returns_400(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr("app.api.ingest.MAX_READINGS_PER_MULTI_REQUEST", 3)
    await _create_sensor(client, "ml-a")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"sensors": [{"ingestKey": "ml-a", "readings": [{"value": 1}] * 4}]},
    )
    assert resp.status_code == 400


async def test_multi_sensor_with_device_time(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    a = await _create_sensor(client, "md-a")
    b = await _create_sensor(client, "md-b")
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
    stamp = [(base + timedelta(seconds=i)).isoformat() for i in range(3)]
    sensors = [
        {"ingestKey": key, "readings": [{"value": i, "timestamp": t} for i, t in enumerate(stamp)]}
        for key in ("md-a", "md-b")
    ]
    resp = await client.post(
        "/api/ingest/readings", headers=VALID_HEADERS, json={"sensors": sensors}
    )
    assert resp.status_code == 202
    expected = [base + timedelta(seconds=i) for i in range(3)]
    assert await _stored_times(a) == expected
    assert await _stored_times(b) == expected
    # 1 つでも範囲外の時刻があれば、全体を受け付けない
    bad = {"ingestKey": "md-a", "value": 1, "timestamp": (base + timedelta(days=1)).isoformat()}
    resp = await client.post(
        "/api/ingest/readings", headers=VALID_HEADERS, json={"sensors": [sensors[1], bad]}
    )
    assert resp.status_code == 400


async def test_multi_sensor_auto_creates_missing_sensors(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_auto_create", True)
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "sensors": [
                {"ingestKey": "ma-1", "name": "電圧1", "unit": "V", "value": 1},
                {"ingestKey": "ma-2", "name": "電流1", "unit": "mA", "value": 2},
            ]
        },
    )
    assert resp.status_code == 202
    assert resp.json()["accepted"] == 2
    sensors = (await client.get("/api/sensors")).json()
    assert {s["ingestKey"]: s["unit"] for s in sensors} == {"ma-1": "V", "ma-2": "mA"}


async def test_multi_sensor_known_sensors_after_auto_created_one(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """自動登録の commit のあとでも、登録済みのセンサーを処理できる（QA C-1 の回帰）。"""
    monkeypatch.setattr(settings, "ingest_auto_create", True)
    a = await _create_sensor(client, "c1-a")
    b = await _create_sensor(client, "c1-b")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "sensors": [
                {"ingestKey": "c1-a", "value": 1},
                {"ingestKey": "c1-new", "value": 2},
                {"ingestKey": "c1-b", "value": 3},
                {"ingestKey": "c1-new", "value": 4},
            ]
        },
    )
    assert resp.status_code == 202
    assert resp.json() == {"accepted": 4, "rejected": []}
    assert await _count(a) == 1
    assert await _count(b) == 1


async def test_multi_sensor_unexpected_error_leaves_nothing_in_buffer(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """途中で予期しない例外が出ても、一部だけがバッファに残らない（再送で二重にならない）。"""
    sensor_id = await _create_sensor(client, "c2-a")
    await _create_sensor(client, "c2-b")
    real_find = ingest_module._auto_create_sensor

    async def boom(*args: object, **kwargs: object) -> object:
        raise RuntimeError("unexpected")

    monkeypatch.setattr(ingest_module, "_auto_create_sensor", boom)
    transport = httpx.ASGITransport(app=app, raise_app_exceptions=False)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as quiet:
        resp = await quiet.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={
                "sensors": [{"ingestKey": "c2-a", "value": 1}, {"ingestKey": "c2-x", "value": 2}]
            },
        )
    assert resp.status_code == 500
    monkeypatch.setattr(ingest_module, "_auto_create_sensor", real_find)
    assert await _count(sensor_id) == 0


async def test_device_time_out_of_order_does_not_break_alarm_times(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """時刻が前後した送信でも、解決の時刻が発生より前にならない（QA H-1 の回帰）。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    resp = await client.post(
        "/api/sensors",
        json={"name": "h1", "ingestKey": "h1", "unit": "C", "thresholdMaxCritical": 10.0},
    )
    assert resp.status_code == 201
    base = datetime.now(UTC).replace(microsecond=0)
    # 到着順は [超過 -10s, 正常 -20s, 超過 -30s]。時刻順では 超過(-30) → 正常(-20) → 超過(-10)
    readings = [
        {"value": 20, "timestamp": (base - timedelta(seconds=10)).isoformat()},
        {"value": 5, "timestamp": (base - timedelta(seconds=20)).isoformat()},
        {"value": 30, "timestamp": (base - timedelta(seconds=30)).isoformat()},
    ]
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "h1", "readings": readings},
    )
    assert resp.status_code == 202
    await flush_once()
    alarms = (await client.get("/api/alarms")).json()["alarms"]
    assert len(alarms) == 2
    for alarm in alarms:
        if alarm["resolvedAt"] is not None:
            assert alarm["resolvedAt"] >= alarm["triggeredAt"]
    # 古い正常値が、あとから来ても、発生中のアラームを解決しない
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "ingestKey": "h1",
            "value": 1,
            "timestamp": (base - timedelta(seconds=100)).isoformat(),
        },
    )
    assert resp.status_code == 202
    await flush_once()
    active = (await client.get("/api/alarms", params={"status": "active"})).json()["alarms"]
    assert len(active) == 1


# ---- 時刻ごとにまとめる形（samples）と、秒単位の時刻 ----


async def test_samples_form_saves_each_value_at_its_time(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    ids = {key: await _create_sensor(client, key) for key in ("s-v", "s-i", "s-e")}
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
    samples = [
        {
            "timestamp": (base + timedelta(seconds=i)).isoformat(),
            "values": {"s-v": 12.0 + i, "s-i": 0.5, "s-e": -1.2},
        }
        for i in range(3)
    ]
    resp = await client.post(
        "/api/ingest/readings", headers=VALID_HEADERS, json={"samples": samples}
    )
    assert resp.status_code == 202
    assert resp.json() == {"accepted": 9, "rejected": []}
    expected = [base + timedelta(seconds=i) for i in range(3)]
    for key in ids:
        assert await _stored_times(ids[key]) == expected


async def test_samples_form_rejects_only_bad_sensors(client: httpx.AsyncClient) -> None:
    good = await _create_sensor(client, "sr-good")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"samples": [{"values": {"sr-good": 1, "sr-nope": 2}}]},
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["accepted"] == 1
    assert [(r["ingestKey"], r["status"]) for r in body["rejected"]] == [("sr-nope", 404)]
    assert await _count(good) == 1


@pytest.mark.parametrize(
    "body",
    [
        {"samples": [{"values": {"": 1}}]},
        {"samples": [{"values": {"a\x00b": 1}}]},
        {"samples": [{"values": {"a": "x"}}]},
        {"samples": [{"values": {"a": 1}}], "sensors": []},
        {"samples": [{"values": {"a": 1}}], "ingestKey": "a", "value": 1},
    ],
    ids=["empty-key", "nul-key", "bad-value", "with-sensors", "with-ingest-key"],
)
async def test_samples_form_bad_shape_returns_400(
    client: httpx.AsyncClient, body: dict[str, object]
) -> None:
    resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=body)
    assert resp.status_code == 400


async def test_samples_bad_time_is_rejected_only_when_on(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """壊れた時刻は、INGEST_DEVICE_TIME=on のときだけ 400。off では無視して 202。"""
    await _create_sensor(client, "samp-bad")
    body = {"samples": [{"timestamp": "x", "values": {"samp-bad": 1}}]}
    resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=body)
    assert resp.status_code == 202
    monkeypatch.setattr(settings, "ingest_device_time", True)
    resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=body)
    assert resp.status_code == 400


async def test_device_time_is_cut_to_whole_seconds(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setattr(settings, "ingest_device_time", True)
    sensor_id = await _create_sensor(client, "sec-cut")
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(seconds=30)
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={
            "ingestKey": "sec-cut",
            "readings": [
                {"value": 1, "timestamp": (base + timedelta(milliseconds=900)).isoformat()},
                {"value": 2, "timestamp": (base + timedelta(milliseconds=100)).isoformat()},
            ],
        },
    )
    assert resp.status_code == 202
    # 同じ秒の 2 件は、1 件にまとまる（後の 1 件を捨てる）
    assert await _stored_times(sensor_id) == [base]


@pytest.mark.parametrize("unit_value", [1.7e12, 1.7e15, 1e11])
async def test_numeric_timestamp_must_be_seconds(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch, unit_value: float
) -> None:
    """ミリ秒・マイクロ秒の数値は、時刻として受け付けない。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    await _create_sensor(client, "num-ms")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "num-ms", "value": 1, "timestamp": unit_value},
    )
    assert resp.status_code == 400


async def test_saas_mode_uses_device_time_for_samples_and_sensors(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SaaS（multi_tenant）でも、INGEST_DEVICE_TIME=on なら機器の時刻を使う。
    範囲内（30 日より前まで）の時刻は、そのまま保存する。未登録は自動登録しない（404）。"""
    sensor_id = await _create_sensor(client, "saas-s1")
    monkeypatch.setattr(settings, "ingest_device_time", True)
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    monkeypatch.setattr(settings, "ingest_auto_create", True)
    old = (datetime.now(UTC) - timedelta(days=5)).replace(microsecond=0)
    resp = await client.post(
        "/api/ingest/readings",
        json={
            "samples": [
                {"timestamp": old.isoformat(), "values": {"saas-s1": 1, "saas-nope": 2}},
            ]
        },
    )
    assert resp.status_code == 202
    body = resp.json()
    assert body["accepted"] == 1
    assert [(r["ingestKey"], r["status"]) for r in body["rejected"]] == [("saas-nope", 404)]
    (stored,) = await _stored_times(sensor_id)
    assert stored == old  # 機器の時刻（5 日前）で保存する


async def test_saas_mode_rejects_device_time_out_of_range(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """SaaS でも時刻の範囲（30 日より前）は 400。他の利用者の時計の狂いを、ここで止める。"""
    await _create_sensor(client, "saas-range")
    monkeypatch.setattr(settings, "ingest_device_time", True)
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    too_old = (datetime.now(UTC) - timedelta(days=60)).replace(microsecond=0).isoformat()
    resp = await client.post(
        "/api/ingest/readings",
        json={"samples": [{"timestamp": too_old, "values": {"saas-range": 1}}]},
    )
    assert resp.status_code == 400


# ---- QA 再レビューの指摘（H-D・H-C・H-B）の回帰テスト ----


@pytest.mark.parametrize(
    "stamp",
    [1730000000000, "garbage", 0, True, "2026-10-30"],
    ids=["ms-number", "garbage-string", "zero", "bool", "date-only"],
)
async def test_device_time_shape_is_ignored_when_off(
    client: httpx.AsyncClient, stamp: object
) -> None:
    """INGEST_DEVICE_TIME=off（既定）では、timestamp はどんな値でも無視する（202 のまま）。"""
    sensor_id = await _create_sensor(client, "off-shape")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "off-shape", "value": 1, "timestamp": stamp},
    )
    assert resp.status_code == 202
    (stored,) = await _stored_times(sensor_id)
    assert stored > datetime.now(UTC) - timedelta(minutes=1)


async def test_device_time_zero_is_rejected_when_on(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """timestamp の 0 は、機器の時刻として 0（1970 年）になるので、過去の範囲外で 400。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    await _create_sensor(client, "on-zero")
    resp = await client.post(
        "/api/ingest/readings",
        headers=VALID_HEADERS,
        json={"ingestKey": "on-zero", "value": 1, "timestamp": 0},
    )
    assert resp.status_code == 400


async def test_resolved_then_older_breach_does_not_open_new_alarm(
    client: httpx.AsyncClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    """解決より前の超過が、あとから届いても、新しい発生中のアラームを作らない（QA H-C）。"""
    monkeypatch.setattr(settings, "ingest_device_time", True)
    resp = await client.post(
        "/api/sensors",
        json={"name": "hc", "ingestKey": "hc", "unit": "C", "thresholdMaxCritical": 10.0},
    )
    assert resp.status_code == 201
    base = datetime.now(UTC).replace(microsecond=0) - timedelta(minutes=5)

    async def send(value: float, seconds: int) -> None:
        resp = await client.post(
            "/api/ingest/readings",
            headers=VALID_HEADERS,
            json={
                "ingestKey": "hc",
                "value": value,
                "timestamp": (base + timedelta(seconds=seconds)).isoformat(),
            },
        )
        assert resp.status_code == 202
        await flush_once()

    await send(30, 0)  # 超過 → 発生
    await send(1, 20)  # 正常 → 解決（20 秒時点）
    await send(40, 10)  # 解決より前の超過（あとから届いた）
    active = (await client.get("/api/alarms", params={"status": "active"})).json()["alarms"]
    assert active == []
    all_alarms = (await client.get("/api/alarms")).json()["alarms"]
    assert len(all_alarms) == 1


async def test_body_over_limit_is_rejected_before_parsing(client: httpx.AsyncClient) -> None:
    """本文が上限（8MB）を超えると、読む前に 413 にする（QA H-B）。"""
    await _create_sensor(client, "big-body")
    huge = {"ingestKey": "big-body", "value": 1, "pad": "x" * (9 * 1024 * 1024)}
    resp = await client.post("/api/ingest/readings", headers=VALID_HEADERS, json=huge)
    assert resp.status_code == 413


async def test_too_many_samples_values_rejected_before_building(
    client: httpx.AsyncClient,
) -> None:
    """件数の超過は、組み立ての前に 400（大量の値をバッファに入れない）。"""
    values = {f"k{i}": 1.0 for i in range(2000)}
    # 72,000 件（上限 70,000 を超える）
    samples = [{"values": values} for _ in range(36)]
    resp = await client.post(
        "/api/ingest/readings", headers=VALID_HEADERS, json={"samples": samples}
    )
    assert resp.status_code == 400
