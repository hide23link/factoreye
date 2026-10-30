"""POST /api/ingest/readings — センサー値の取り込み（ingest ＝ 取り込み）。

【この API の呼ばれ方】機器（Arduino / M5Stack / Raspberry Pi）が、測定のたびに送る。

    POST http://<サーバー>:8000/api/ingest/readings
    ヘッダー: X-API-Key: <共有の鍵>        ← self-hosted のとき（SaaS では不要）
    本文（JSON）:
        {"ingestKey": "line1-temp", "value": 23.5}                      ← 1件
        {"ingestKey": "line1-temp", "readings": [{"value": 23.5}, ...]} ← まとめて複数件
    INGEST_DEVICE_TIME=on（self-hosted だけ）なら、各値に "timestamp"（時差つきの ISO 8601 か
    UNIX 秒）を付けて、測った時刻（秒単位に切り捨て）で保存できる（付けなければ受信時刻）。
    範囲外・時差なし・ミリ秒の数値は 400。
        {"sensors": [{"ingestKey": "a", "readings": [...]}, ...]}      ← センサーごとにまとめる
        {"samples": [{"timestamp": ..., "values": {"a": 1, "b": 2}}]}  ← 時刻ごとにまとめる
    返事: 202 {"accepted": 件数}
    失敗: 400 本文が間違い / 401 鍵が違う / 403 センサーが無効（自動で作る上限に達したときも）
          / 404 ingestKey が未登録 / 409 自動で作るときに、名前が重なり続けた（まれ）/ 429 送りすぎ
    INGEST_AUTO_CREATE=on（self-hosted だけ）なら、未登録の ingestKey は 404 にせず、
    センサーを自動で作る（本文に "name"・"unit" を付けると、その名前・単位で作る。
    付けなければ、名前は ingestKey、単位は "-"）。

【引数】ingest_readings の request と session は、呼び出す人が渡すものではない。
FastAPI が、リクエストを受けるたびに自動で用意して渡す（session は Depends の指定どおり）。

【処理の流れ】認証と回数の制限 → 本文の検査 → ingestKey でセンサーを探す → バッファに入れて 202。
DB への書き込みは、このあと 1 秒ごとにまとめて行う（app/ingest_buffer.py）。
"""
import functools
import json
import logging
import re
from collections.abc import Callable
from datetime import UTC, datetime, timedelta
from typing import Any
from uuid import UUID, uuid4

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlalchemy import text
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, func, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import ingest_limit_toggle  # 管理画面から、期限付きで回数の制限を外す仕組み
from app.api.deps import verify_ingest_api_key  # 機器の認証（X-API-Key の確認）
from app.config import settings
from app.db.models import Sensor
from app.db.session import get_session
from app.ingest_buffer import PendingReading, buffer  # buffer = DB に書く前の、一時的な置き場
from app.rate_limit import limiter  # 回数の制限をかける道具
from app.schemas import (
    MAX_READINGS_PER_MULTI_REQUEST,
    IngestAccepted,
    IngestRejected,
    IngestRequest,
    ReadingIn,
    SensorReadings,
)  # 届く本文の形 / 返事の形

# URL の頭が /api/ingest のものを、このファイルが受け持つ（main.py で登録される）
router = APIRouter(prefix="/api/ingest", tags=["ingest"])

logger = logging.getLogger(__name__)

# センサーごとに、前の送信に割り当てた最後の recorded_at を覚える（プロセス内。センサー数だけ）。
# 取り込みの時刻を、これより必ず _STEP 以上進める（理由は ingest_readings 内）
_STEP = timedelta(microseconds=1)
_EPOCH = datetime.min.replace(tzinfo=UTC)
_last_assigned: dict[UUID, datetime] = {}

# 機器の測定時刻（INGEST_DEVICE_TIME=on）として受け付ける範囲。範囲外の timestamp を含む送信は、
# 全体を 400 にする（機器に、時計のずれを知らせるため）。
# 未来は NTP のずれと通信の揺らぎ分だけ、過去は通信が切れて溜めた分を後から送れる長さにする
DEVICE_TIME_MAX_FUTURE = timedelta(seconds=10)
DEVICE_TIME_MAX_PAST = timedelta(days=30)

# INGEST_RATE_LIMIT=off のときは制限を付けない（実機テスト用の解除モード）。
# 既定値（100/minute）は本番と同じ。解除中は起動時にログで警告する。
RATE_LIMIT_OFF = "off"


def limit_ingest_rate(original_function: Callable[..., Any]) -> Callable[..., Any]:
    """取り込み API に、回数の制限を付ける。管理画面で期限付き解除中は、制限を通さない。

    使い方: 関数の上に `@limit_ingest_rate` と書くと、その関数（original_function）が包まれる。
    環境変数が off のときは、何も付けずに返す（環境変数が管理画面より優先）。
    """
    if settings.ingest_rate_limit.strip().lower() == RATE_LIMIT_OFF:
        return original_function
    # 制限つきの版（例: 100/minute ＝ 1分に100回まで。超えると 429）
    limited: Callable[..., Any] = limiter.limit(settings.ingest_rate_limit)(original_function)

    # wraps は、名前や説明を元の関数のままにする（FastAPI が処理を結びつけるのに必要）
    @functools.wraps(original_function)
    async def check_and_run(*args: Any, **kwargs: Any) -> Any:
        # 解除中かどうかは、リクエストごとにメモリを見るだけ（DB には触れない）
        if ingest_limit_toggle.is_limit_off():
            return await original_function(*args, **kwargs)
        return await limited(*args, **kwargs)

    return check_and_run


def _check_device_times(readings: list[ReadingIn], now: datetime) -> None:
    """機器の timestamp が、使える時刻か確かめる。だめなら 400（送信全体を受け付けない）。

    時差の無い時刻（"2026-10-30T12:00:00"）は、いつの時刻か決まらないので受け付けない。
    """
    for reading in readings:
        timestamp = reading.timestamp
        if timestamp is None:
            continue
        if timestamp.tzinfo is None:
            detail = "timestamp must include a time zone (e.g. 2026-10-30T12:00:00Z)"
        elif timestamp > now + DEVICE_TIME_MAX_FUTURE:
            detail = "timestamp is in the future (check the device clock)"
        elif timestamp < now - DEVICE_TIME_MAX_PAST:
            detail = "timestamp is too old"
        else:
            continue
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail=detail)


# 自動で作るときの ingestKey に使える文字と長さ（打ち間違いで、センサーが増えないように）。
# fullmatch を使う（match の $ は、末尾の改行を許してしまう）
AUTO_CREATE_KEY_PATTERN = re.compile(r"[A-Za-z0-9._-]{1,64}")
# 名前も単位も付いていないときの単位（センサーの単位は、空にできない）
AUTO_CREATE_DEFAULT_UNIT = "-"
# 名前・単位から取り除く文字: 制御文字（改行・NUL など）と、表示の向きを変える文字（RTL など）
_UNSAFE_TEXT_CHARS = re.compile("[\x00-\x1f\x7f\u200e\u200f\u202a-\u202e\u2066-\u2069]")
# 自動で作る処理を、同時に 1 つずつにする鍵（PostgreSQL の advisory lock の番号）。
# 上限の判定と作成の間に、ほかの処理が割り込まないようにする
_AUTO_CREATE_LOCK_ID = 74283610


def clean_text(text: str | None, max_length: int) -> str:
    """名前・単位を整える。制御文字などを取り除き、前後の空白を削り、max_length に切る。
    結果が空になることもある。

    拒否はしない（拒否すると、機器が 4xx で値を捨ててしまうため）。
    使えない文字は、取り除くだけにする。
    """
    if text is None:
        return ""
    return _UNSAFE_TEXT_CHARS.sub("", text).strip()[:max_length]


async def _find_sensor(session: AsyncSession, ingest_key: str) -> Sensor | None:
    return (await session.exec(select(Sensor).where(Sensor.ingest_key == ingest_key))).first()


async def _name_is_taken(session: AsyncSession, name: str) -> bool:
    return (await session.exec(select(Sensor.id).where(Sensor.name == name))).first() is not None


def _name_candidates(name: str, ingest_key: str) -> list[str]:
    """使う名前の候補を、希望の順に返す。名前は、ワークスペース内で一意なので、重なったら次の候補にする。

    1. 機器が付けた名前  2. 「名前 (ingestKey)」（名前を切り詰めて、後ろの (ingestKey) は必ず残す）
    3. ingestKey そのもの
    4. ingestKey に乱数を付けたもの（ほかの候補が、すべて重なったときの最後の手段）
    """
    suffix = f" ({ingest_key})"
    candidates = [
        name,
        name[: 100 - len(suffix)] + suffix,
        ingest_key,
        f"{ingest_key}-{uuid4().hex[:6]}",
    ]
    return list(dict.fromkeys(candidate for candidate in candidates if candidate))  # 重複と空を除く


async def _auto_create_sensor(
    session: AsyncSession, ingest_key: str, name: str | None, unit: str | None
) -> Sensor:
    """未登録の ingestKey のセンサーを、自動で作る。使えない設定のときは、404（未登録）にする。

    使えるのは、INGEST_AUTO_CREATE=on の self-hosted だけ。
    次の決まりで、ゴミのセンサーが増えるのを防ぐ:
    - ingestKey は、英数字と . _ - だけ、64 文字まで（違えば 400）
    - センサーの総数（無効なものも数える）が INGEST_AUTO_CREATE_MAX_SENSORS に達したら、
      作らない（403）
    - 名前・単位は、制御文字などを取り除き、長さを切って使う（空なら、名前は ingestKey、単位は "-"）
    - 名前が、すでにあるセンサーと重なるときは、候補を順に試す（_name_candidates）
    - 作る処理は、同時に 1 つずつ行う（PostgreSQL の advisory lock）ので、上限を超えず、
      同時に同じ ingestKey が来ても、センサーは 1 つだけ作る
    """
    if not settings.ingest_auto_create_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown ingestKey")
    if not AUTO_CREATE_KEY_PATTERN.fullmatch(ingest_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ingestKey for auto-create: A-Z a-z 0-9 . _ - only, up to 64 characters",
        )

    # ここから、同時に 1 つずつ（トランザクションの終わりで、自動で外れる）
    await session.exec(text(f"SELECT pg_advisory_xact_lock({_AUTO_CREATE_LOCK_ID})"))  # type: ignore[call-overload]
    existing = await _find_sensor(session, ingest_key)
    if existing is not None:  # 順番を待つ間に、同じ ingestKey が先に作られた
        return existing
    count_query = select(func.count()).select_from(Sensor).where(col(Sensor.workspace_id).is_(None))
    sensor_count = (await session.exec(count_query)).one()
    if sensor_count >= settings.ingest_auto_create_max_sensors:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"auto-create limit reached ({settings.ingest_auto_create_max_sensors} sensors)",
        )

    clean_name = clean_text(name, 100) or ingest_key
    clean_unit = clean_text(unit, 20) or AUTO_CREATE_DEFAULT_UNIT
    for candidate in _name_candidates(clean_name, ingest_key):
        if await _name_is_taken(session, candidate):
            continue
        sensor = Sensor(workspace_id=None, name=candidate, ingest_key=ingest_key, unit=clean_unit)
        session.add(sensor)
        try:
            await session.commit()
        except IntegrityError:  # 鍵で順番を待つので、通常は起きない（念のため、次の候補へ）
            await session.rollback()
            continue
        await session.refresh(sensor)
        # ログには、%r で出す（改行などが入っていても、1 行のまま。偽のログ行を作らせない）
        logger.warning(
            "auto-created sensor: ingestKey=%r name=%r unit=%r",
            sensor.ingest_key,
            sensor.name,
            sensor.unit,
        )
        return sensor
    raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="name already in use")


# 202 ＝ 受け付けた（まだ DB には入っていないことがある）
# 下から順に関数を包む: 回数の制限 → 認証（dependencies）→ この URL に結びつける
@router.post(
    "/readings",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_ingest_api_key)],
)
@limit_ingest_rate
async def ingest_readings(
    request: Request, session: AsyncSession = Depends(get_session)
) -> IngestAccepted:
    """測定値を受け付ける。本文は JSON（単発の value か、readings の配列）。"""
    # ① 本文を JSON として読む
    try:
        raw_body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid JSON body"
        ) from error

    # ② 中身が決めた形か検査する（ingestKey は必須、value は数値、など）
    try:
        request_data = IngestRequest.model_validate(raw_body)
    except ValidationError as error:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=error.errors(include_input=False),
        ) from error

    # ③ 1 センサーの形（ingestKey）と、複数センサーの形（sensors）に分ける
    use_device_time = settings.ingest_device_time_active
    now = datetime.now(UTC)

    items = request_data.to_sensor_items()
    if items is None:
        # 従来の形: 問題があれば、そのまま 4xx を返す
        # IngestRequest の検査で、ingestKey か sensors のどちらか 1 つは必ずある
        assert request_data.ingest_key is not None
        sensor_id, readings = await _resolve_sensor(
            session, request_data, request_data.ingest_key, None
        )
        accepted = await _buffer_readings(sensor_id, readings, use_device_time, now)
        return IngestAccepted(accepted=accepted)

    # 複数センサーの形（sensors か samples）: センサーごとに結果を出す。
    # 1 つのセンサーの問題（未登録・無効など）で、
    # ほかのセンサーを捨てない。送信全体の問題（件数の超過・時刻の不正）は、全体を 400 にする
    if sum(len(item.to_readings()) for item in items) > MAX_READINGS_PER_MULTI_REQUEST:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"too many readings (max {MAX_READINGS_PER_MULTI_REQUEST} in total)",
        )
    if use_device_time:
        for item in items:
            _check_device_times(item.to_readings(), now)
    # 登録済みのセンサーは、1 回の問い合わせでまとめて探す（未登録だけ、個別に処理する）。
    # 自動登録の commit で、読んだ Sensor が期限切れになる（セッションの既定）ので、
    # Sensor そのものではなく、使う値（id と enabled）だけを取り出して持つ
    keys = {item.ingest_key for item in items}
    found = (await session.exec(select(Sensor).where(col(Sensor.ingest_key).in_(keys)))).all()
    known = {sensor.ingest_key: (sensor.id, sensor.enabled) for sensor in found}

    # 第 1 段: すべてのセンサーを確かめる（ここではバッファに入れない）。
    # 途中で予期しない例外が出ても、一部だけがバッファに残って、再送で二重にならない
    resolved: list[tuple[UUID, list[ReadingIn]]] = []
    rejected: list[IngestRejected] = []
    for item in items:
        try:
            resolved.append(await _resolve_sensor(session, item, item.ingest_key, known))
        except HTTPException as error:
            rejected.append(
                IngestRejected(
                    ingest_key=item.ingest_key,
                    status=error.status_code,
                    detail=error.detail if isinstance(error.detail, str) else "invalid",
                )
            )
    # 第 2 段: バッファに入れる（DB には触れない。ここから先で失敗する要因は無い）
    accepted = 0
    for sensor_id, readings in resolved:
        accepted += await _buffer_readings(sensor_id, readings, use_device_time, now)
    return IngestAccepted(accepted=accepted, rejected=rejected)


async def _resolve_sensor(
    session: AsyncSession,
    data: IngestRequest | SensorReadings,
    ingest_key: str,
    known: dict[str, tuple[UUID, bool]] | None,
) -> tuple[UUID, list[ReadingIn]]:
    """1 つのセンサー分を確かめて、(センサーの id, 測定値のリスト) を返す。

    問題があれば HTTPException（400 値が無い / 403 無効 / 404 未登録 など）。
    known は、複数センサーの形で先にまとめて探した結果 {ingestKey: (id, enabled)}
    （従来の形では None）。
    """
    # 「1件」「複数件」の2通りの書き方を、測定値のリストにそろえる
    readings = data.to_readings()
    if not readings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="value or readings is required"
        )

    # ingestKey でセンサーを探す（キーは全体で一意。SaaS でも self-hosted でも、キーだけで決まる）
    if known is not None and ingest_key in known:
        sensor_id, enabled = known[ingest_key]
    else:
        sensor = await _find_sensor(session, ingest_key) if known is None else None
        if sensor is None:
            # 未登録: INGEST_AUTO_CREATE=on（self-hosted）なら作る。そうでなければ 404
            sensor = await _auto_create_sensor(session, ingest_key, data.name, data.unit)
        sensor_id, enabled = sensor.id, sensor.enabled
        if known is not None:
            known[ingest_key] = (sensor_id, enabled)  # 同じ送信内の同じキーは、作り直さない
    if not enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="sensor disabled")
    return sensor_id, readings


async def _buffer_readings(
    sensor_id: UUID, readings: list[ReadingIn], use_device_time: bool, now: datetime
) -> int:
    """1 つのセンサー分の測定値を、バッファに入れる。入れた件数を返す。

    時刻は、既定では機器の時計ではなく、サーバーが受け取った時刻を使う
    （機器の timestamp は信頼しない。docs/architecture.md §3 データモデル参照）。
    ただし INGEST_DEVICE_TIME=on の self-hosted では、timestamp を付けた値は、その時刻で保存する
    （付けない値は、受信時刻のまま。一部だけ付けた送信も受け付ける）。
    測定値の主キーは (sensor_id, recorded_at) で、同じ時刻の値は 1 件だけ（app/db/models.py）。
    このため、受信時刻を割り当てる値は、センサーごとに「前に割り当てた時刻」を覚え、
    それより必ず 1 マイクロ秒以上進める。
    1 回の送信内の複数の値も、別々の送信も、時刻が重ならない（時計が戻っても重ならない）。
    受信時刻の割り当ては await を挟まずに行うので、同時に来た送信どうしでも重ならない。
    機器の時刻どうしが同じ（再送など）場合は、書き込みで後の 1 件を捨てる（二重にならない。
    応答の accepted は受け付けた件数で、保存した件数ではない）
    """
    if use_device_time:
        _check_device_times(readings, now)
    server_time_count = sum(1 for r in readings if not (use_device_time and r.timestamp))
    start = max(now, _last_assigned.get(sensor_id, _EPOCH) + _STEP)
    if server_time_count:
        _last_assigned[sensor_id] = start + _STEP * (server_time_count - 1)
    server_time_index = 0
    for reading in readings:
        if use_device_time and reading.timestamp:
            # 時刻は秒で管理する（小数の秒は切り捨てる）
            recorded_at = reading.timestamp.astimezone(UTC).replace(microsecond=0)
        else:
            recorded_at = start + _STEP * server_time_index
            server_time_index += 1
        await buffer.add(
            PendingReading(sensor_id=sensor_id, value=reading.value, recorded_at=recorded_at)
        )
    return len(readings)
