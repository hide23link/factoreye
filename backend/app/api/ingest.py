"""POST /api/ingest/readings — センサー値の取り込み（単発 or バッチ）。

デバイスはここに測定値を送る。流れ:
1. 認証（verify_ingest_api_key）と、レート制限（_ingest_rate_limit）
2. 本文の検査（JSON・必須項目）
3. 取り込みキー（ingestKey）からセンサーを探す（無い・無効なら拒否）
4. 受信バッファに入れて、すぐ 202 Accepted を返す（DB への書き込みは 1 秒ごとにまとめて行う）
"""
# ── Python の標準の道具 ──
import functools  # wraps: 包んだ関数に、元の関数の名前や説明を引き継ぐ（下の gated で使う）
import json  # 受け取った本文が JSON として読めなかったときのエラー（JSONDecodeError）に使う
from collections.abc import Callable  # 「関数」を表す型。型の注釈にだけ使う
from datetime import UTC, datetime  # 受け取った時刻（UTC＝世界標準時）を作る
from typing import Any  # 「何でもよい型」。型の注釈にだけ使う

# ── 外部ライブラリ ──
from fastapi import APIRouter, Depends, HTTPException, Request, status
# APIRouter: この API の窓口（URL と処理の対応表）。main.py で登録される
# Depends: 処理の前に実行する部品を指定する（認証や DB 接続）
# HTTPException: エラーの応答（400 や 404 など）を返すために投げる
# Request: 届いたリクエスト（本文など）を読む
# status: HTTP の番号に名前を付けたもの（202 → HTTP_202_ACCEPTED）
from pydantic import ValidationError  # 入力の形が決まりに合わなかったときのエラー
from sqlmodel import select  # DB から探す文（SQL）を作る
from sqlmodel.ext.asyncio.session import AsyncSession  # DB との会話（接続）1回分。型の注釈に使う

# ── このアプリの中の部品 ──
from app import ingest_limit_toggle  # 管理画面から、期限付きで制限を外す仕組み（メモリに保存）
from app.api.deps import verify_ingest_api_key  # 機器の認証（X-API-Key の確認）
from app.config import settings  # 環境変数の設定（制限の回数 INGEST_RATE_LIMIT など）
from app.db.models import Sensor  # センサーのテーブル
from app.db.session import get_session  # DB 接続を作る部品。Depends で使う
from app.ingest_buffer import PendingReading, buffer
# PendingReading: まだ DB に書いていない測定値1件
# buffer: 測定値を一時的に溜めておく場所（1秒ごとに DB へ書く）
from app.rate_limit import limiter  # 回数の制限をかける道具（slowapi）
from app.schemas import IngestAccepted, IngestRequest
# IngestRequest: 機器から届く本文の形（ingestKey・value・readings）
# IngestAccepted: 返事の形（受け付けた件数）

# この API の窓口。URL の頭が /api/ingest のものを、ここで受け持つ。
# tags は、API の仕様書（/docs）で、同じ仲間としてまとめて表示するための名前
router = APIRouter(prefix="/api/ingest", tags=["ingest"])

# INGEST_RATE_LIMIT=off のときは制限を付けない（実機テスト用の解除モード）。
# 既定値（100/minute）は本番と同じ。解除中は起動時にログで警告する。
RATE_LIMIT_OFF = "off"


def _ingest_rate_limit(handler: Callable[..., Any]) -> Callable[..., Any]:
    """取り込み API に制限を付ける。管理画面で期限付き解除中は、制限を通さない。

    環境変数が off のときは、何も付けずに返す（環境変数が管理画面より優先）。

    使い方: 関数の上に `@_ingest_rate_limit` と書くと、その関数が「包まれる」。
    （handler = 包まれる元の関数。ここでは ingest_readings）
    """
    # 環境変数で制限なし（off）なら、何もせず、元の関数をそのまま返す
    if settings.ingest_rate_limit.strip().lower() == RATE_LIMIT_OFF:
        return handler
    # 制限つきの版を作る（例: 100/minute ＝ 1分に100回まで。超えると 429 を返す）
    limited: Callable[..., Any] = limiter.limit(settings.ingest_rate_limit)(handler)

    # wraps: 名前や説明を元の関数のままにする（FastAPI が URL と処理を結びつけるのに必要）
    @functools.wraps(handler)
    async def gated(*args: Any, **kwargs: Any) -> Any:
        """リクエストが来るたびに、制限を使うか外すかを選んで実行する（gate = 門）。"""
        # 解除中の判定はリクエストごとにメモリを見るだけ（DB には触れない）
        if ingest_limit_toggle.is_bypassed():
            return await handler(*args, **kwargs)  # 解除中: 制限なしで実行
        return await limited(*args, **kwargs)  # 通常: 制限つきで実行

    return gated


# 取り込み API。202（受け付けた。まだ DB には入っていないことがある）を返す
# 下の3つの印（@ で始まる行）は、上から順に、関数を包んでいく:
#   @router.post(...): POST /api/ingest/readings に来たら、この関数を実行する
#   dependencies: 関数を実行する前に、機器の認証（verify_ingest_api_key）を必ず通す
#   @_ingest_rate_limit: 回数の制限をかける（上の関数）
@router.post(
    "/readings",
    status_code=status.HTTP_202_ACCEPTED,
    dependencies=[Depends(verify_ingest_api_key)],
)
@_ingest_rate_limit
async def ingest_readings(
    request: Request, session: AsyncSession = Depends(get_session)
) -> IngestAccepted:
    """測定値を受け付ける。本文は JSON（単発の value か、readings の配列）。

    引数: request = 届いたリクエスト、session = DB との会話（Depends が自動で用意する）
    """
    # ① 本文を JSON として読む。読めなければ 400（クライアントの間違い）
    try:
        raw_body = await request.json()
    except (json.JSONDecodeError, UnicodeDecodeError) as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="invalid JSON body"
        ) from exc

    # ② JSON の中身が、決めた形（ingestKey は必須、value は数値、など）か検査する。違えば 400
    try:
        payload = IngestRequest.model_validate(raw_body)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=exc.errors(include_input=False),
        ) from exc

    # ③ 「value だけ」「readings の配列」の2通りの書き方を、測定値のリストにそろえる
    readings = payload.to_readings()
    if not readings:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST, detail="value or readings is required"
        )

    # ④ 取り込みキーでセンサーを探す
    # 取り込みキーは全体で一意（SaaS でも self-hosted でも、キーだけでセンサーが決まる）
    sensor_query = select(Sensor).where(Sensor.ingest_key == payload.ingest_key)
    result = await session.exec(sensor_query)
    sensor = result.first()
    if sensor is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="unknown ingestKey")
    if not sensor.enabled:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="sensor disabled")

    # ⑤ バッファに入れる（DB への書き込みは、あとで1秒ごとにまとめて行う）
    # ingest時刻を採用（デバイス側timestampは信頼しない、docs/architecture.md §3 データモデル参照）
    received_at = datetime.now(UTC)
    for reading in readings:
        await buffer.add(
            PendingReading(sensor_id=sensor.id, value=reading.value, recorded_at=received_at)
        )

    # ⑥ 受け付けた件数を返す（202）。DB に入るのは、このあと最大1秒後
    return IngestAccepted(accepted=len(readings))
