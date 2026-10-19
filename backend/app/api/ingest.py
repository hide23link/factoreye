"""POST /api/ingest/readings — センサー値の取り込み（ingest ＝ 取り込み）。

【この API の呼ばれ方】機器（Arduino / M5Stack / Raspberry Pi）が、測定のたびに送る。

    POST http://<サーバー>:8000/api/ingest/readings
    ヘッダー: X-API-Key: <共有の鍵>        ← self-hosted のとき（SaaS では不要）
    本文（JSON）:
        {"ingestKey": "line1-temp", "value": 23.5}                      ← 1件
        {"ingestKey": "line1-temp", "readings": [{"value": 23.5}, ...]} ← まとめて複数件
    返事: 202 {"accepted": 件数}
    失敗: 400 本文が間違い / 401 鍵が違う / 403 センサーが無効（自動で作る上限に達したときも）
          / 404 ingestKey が未登録 / 429 送りすぎ
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
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
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
from app.schemas import IngestAccepted, IngestRequest  # 届く本文の形 / 返事の形

# URL の頭が /api/ingest のものを、このファイルが受け持つ（main.py で登録される）
router = APIRouter(prefix="/api/ingest", tags=["ingest"])

logger = logging.getLogger(__name__)

# 自動で作るときの ingestKey に使える文字と長さ（打ち間違い・変な文字で、センサーが増えないように）
AUTO_CREATE_KEY_PATTERN = re.compile(r"^[A-Za-z0-9._-]{1,64}$")
# 名前も単位も付いていないときの単位（センサーの単位は、空にできない）
AUTO_CREATE_DEFAULT_UNIT = "-"

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


# 202 ＝ 受け付けた（まだ DB には入っていないことがある）
# 下から順に関数を包む: 回数の制限 → 認証（dependencies）→ この URL に結びつける
async def _find_sensor(session: AsyncSession, ingest_key: str) -> Sensor | None:
    return (await session.exec(select(Sensor).where(Sensor.ingest_key == ingest_key))).first()


async def _auto_create_sensor(session: AsyncSession, data: IngestRequest) -> Sensor:
    """未登録の ingestKey のセンサーを、自動で作る。使えない設定のときは、404（未登録）にする。

    使えるのは、INGEST_AUTO_CREATE=on の self-hosted だけ。
    次の決まりで、ゴミのセンサーが増えるのを防ぐ:
    - ingestKey は、英数字と . _ - だけ、64 文字まで（違えば 400）
    - センサーの総数が、INGEST_AUTO_CREATE_MAX_SENSORS に達していたら、作らない（403）
    - 名前が、すでにあるセンサーと重なるときは、名前の後ろに ingestKey を付ける
    - 同時に同じ ingestKey が来ても、センサーは 1 つだけ作る
      （DB の一意制約で、あとの方は、先に作られたものを使う）
    """
    if not settings.ingest_auto_create_active:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown ingestKey")
    if not AUTO_CREATE_KEY_PATTERN.match(data.ingest_key):
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="ingestKey for auto-create: A-Z a-z 0-9 . _ - only, up to 64 characters",
        )
    count_query = select(func.count()).select_from(Sensor).where(col(Sensor.workspace_id).is_(None))
    sensor_count = (await session.exec(count_query)).one()
    if sensor_count >= settings.ingest_auto_create_max_sensors:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail=f"auto-create limit reached ({settings.ingest_auto_create_max_sensors} sensors)",
        )

    name = data.name or data.ingest_key
    unit = data.unit or AUTO_CREATE_DEFAULT_UNIT
    same_name = await session.exec(select(Sensor.id).where(Sensor.name == name))
    if same_name.first() is not None:
        name = f"{name} ({data.ingest_key})"[:100]

    sensor = Sensor(workspace_id=None, name=name, ingest_key=data.ingest_key, unit=unit)
    session.add(sensor)
    try:
        await session.commit()
    except IntegrityError as error:
        await session.rollback()
        # 同時に、同じ ingestKey のリクエストが先に作った場合は、それを使う
        existing = await _find_sensor(session, data.ingest_key)
        if existing is None:  # ingestKey ではなく、名前の重なり（同時に同じ名前で作られた）
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT, detail="name already in use"
            ) from error
        return existing
    await session.refresh(sensor)
    logger.warning(
        "auto-created sensor: ingestKey=%s name=%s unit=%s",
        sensor.ingest_key,
        sensor.name,
        sensor.unit,
    )
    return sensor


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

    # ③ 「1件」「複数件」の2通りの書き方を、測定値のリストにそろえる
    readings = request_data.to_readings()
    if not readings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="value or readings is required"
        )

    # ④ ingestKey でセンサーを探す（キーは全体で一意。SaaS でも self-hosted でも、キーだけで決まる）
    sensor_query = select(Sensor).where(Sensor.ingest_key == request_data.ingest_key)
    result = await session.exec(sensor_query)
    sensor = result.first()
    if sensor is None:
        # 未登録: INGEST_AUTO_CREATE=on（self-hosted）なら作る。そうでなければ 404
        sensor = await _auto_create_sensor(session, request_data)
    if not sensor.enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="sensor disabled")

    # ⑤ バッファに入れる。時刻は、機器の時計ではなく、サーバーが受け取った時刻を使う
    # （機器の timestamp は信頼しない。docs/architecture.md §3 データモデル参照）
    received_at = datetime.now(UTC)
    for reading in readings:
        await buffer.add(
            PendingReading(sensor_id=sensor.id, value=reading.value, recorded_at=received_at)
        )

    return IngestAccepted(accepted=len(readings))
