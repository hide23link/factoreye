"""POST /api/ingest/readings — センサー値の取り込み（ingest ＝ 取り込み）。

【この API の呼ばれ方】機器（Arduino / M5Stack / Raspberry Pi）が、測定のたびに送る。

    POST http://<サーバー>:8000/api/ingest/readings
    ヘッダー: X-API-Key: <共有の鍵>        ← self-hosted のとき（SaaS では不要）
    本文（JSON）:
        {"ingestKey": "line1-temp", "value": 23.5}                      ← 1件
        {"ingestKey": "line1-temp", "readings": [{"value": 23.5}, ...]} ← まとめて複数件
    返事: 202 {"accepted": 件数}
    失敗: 400 本文が間違い / 401 鍵が違う / 403 センサーが無効
          / 404 ingestKey が未登録 / 429 送りすぎ

【引数】ingest_readings の request と session は、呼び出す人が渡すものではない。
FastAPI が、リクエストを受けるたびに自動で用意して渡す（session は Depends の指定どおり）。

【処理の流れ】認証と回数の制限 → 本文の検査 → ingestKey でセンサーを探す → バッファに入れて 202。
DB への書き込みは、このあと 1 秒ごとにまとめて行う（app/ingest_buffer.py）。
"""
import functools
import json
from collections.abc import Callable
from datetime import UTC, datetime
from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Request, status
from pydantic import ValidationError
from sqlmodel import select
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
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown ingestKey")
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
