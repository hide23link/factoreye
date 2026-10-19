"""POST /api/ingest/readings のテスト。

docs/architecture.md §12 テスト のシナリオ（認証・不正ペイロード・
高頻度バッチ）を実装に合わせて踏襲。Alarm評価・dedupeはSprint 4で追加。
"""
import asyncio
import logging
import time
from datetime import UTC, datetime
from uuid import uuid4

import httpx
import pytest

import app.ingest_buffer as ingest_buffer
import app.main as main_module
from app.config import AuthMode, IngestAuth, settings
from app.ingest_buffer import IngestBuffer, PendingReading, flush_once
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


async def _ingest(client: httpx.AsyncClient, key: str, value: float = 1.0, **extra: str) -> int:
    """取り込みを 1 回送って、ステータスコードを返す。extra は name・unit など、本文に足す項目。"""
    body = {"ingestKey": key, "value": value, **extra}
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
    for extra in ({"name": ""}, {"unit": "u" * 21}, {"name": "x" * 101}, {"name": "\x00"}):
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
