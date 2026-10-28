"""
FactorEye バックエンド エントリポイント

このファイルは「アプリの組み立て」だけを担当する。処理の中身は、各モジュールにある:
- app/api/*.py: HTTP の API（ルーター）。ここでは include_router で登録するだけ
- app/ingest_buffer.py: センサー値の受信バッファと、1秒ごとの DB への書き込み（flush_loop）
- app/purge.py: SaaS の古い測定値の定期削除（purge_loop）
- app/alarm_engine.py: 測定値を見てアラームを発生・解除する処理

起動方法:
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload   # 開発
    uvicorn app.main:app --host 0.0.0.0 --port 8000             # 本番（docker-compose経由）
"""

import asyncio
import logging
from collections.abc import AsyncIterator, Awaitable, Callable
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

import jwt
from fastapi import FastAPI, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text
from starlette.responses import Response

from app import webhooks as webhooks_sender

# app/api/ の中の、API の窓口（ルーター）を読み込む。1つの窓口が、1種類のデータを担当する。
# ここで読み込んだだけでは使えない。下の app.include_router(...) で登録して、はじめて使える
from app.api import (
    admin,  # 管理者用の API（利用者の一覧・編集・なりすまし閲覧など）。SaaS 版だけ
    admin_failback,  # 管理者用: 控えが稼いだデータを本番に書き戻す。SaaS 版だけ
    alarms,  # アラームの一覧を見る・確認済みにする
    auth,  # 登録・ログイン・ログアウト。SaaS 版だけ
    dashboards,  # ダッシュボード（画面）の作成・取得・変更・削除
    ingest,  # 機器からの測定値を受け取る（データの入口）
    migration,  # SaaS から OSS（自分のサーバー）へ、データを引っ越す
    readings,  # 測定値の一覧を見る
    sensors,  # センサーの登録・変更・削除と、そのセンサーの測定値の取得
    webhooks,  # Webhook（外部サービスへの通知先）の登録・変更・削除
    widgets,  # ダッシュボードの部品（グラフや数値の表示）の変更・削除
)

# settings は、下の app.config の settings（環境変数の設定）と名前がぶつかるので、別名にしている
from app.api import settings as alert_settings  # Discord 通知の設定を見る・変える
from app.auth import decode_access_token
from app.config import AuthMode, settings
from app.db.session import engine
from app.ingest_buffer import flush_loop, flush_once
from app.purge import purge_loop
from app.rate_limit import limiter
from app.validation import handle_input_error


@asynccontextmanager
async def start_and_stop(app: FastAPI) -> AsyncIterator[None]:
    """アプリの起動から終了までの処理。

    起動時: 取り込みのレート制限の解除・キーなしの取り込みを警告し、常駐タスク
    （バッファ書き込み・古いデータの削除）を開始する。
    終了時: 常駐タスクを止め、バッファに残った測定値を書いてから、Webhook の送信用の接続と
    DB への接続プールを閉じる。
    """
    logger = logging.getLogger(__name__)
    if settings.ingest_rate_limit.strip().lower() == "off":
        logger.warning(
            "INGEST_RATE_LIMIT=off: 取り込みのレート制限を解除しています（実機テスト用）"
        )
    if settings.auth_mode == AuthMode.DISABLED and not settings.ingest_requires_key:
        logger.warning(
            "INGEST_AUTH=off: 取り込みをキーなしで受け付けています。"
            "取り込みの口を LAN などに限定してください"
        )
    if settings.ingest_auto_create_active:
        logger.warning(
            "INGEST_AUTO_CREATE=on: 未登録の ingestKey のセンサーを自動で作ります（最大 %d 個）",
            settings.ingest_auto_create_max_sensors,
        )
    elif settings.ingest_auto_create:
        logger.warning("INGEST_AUTO_CREATE=on は、SaaS（multi_tenant）では使えません。無視します")
    flush_task = asyncio.create_task(flush_loop())
    purge_task = asyncio.create_task(purge_loop())
    yield
    flush_task.cancel()
    purge_task.cancel()
    # 書き込み中に止めた場合も、値は flush_once がバッファに戻すので、終了を待ってから書く
    await asyncio.gather(flush_task, purge_task, return_exceptions=True)
    try:
        await flush_once()
    except Exception:
        # DB に書けなくても停止は続ける（再起動を妨げないため）
        logger.exception("final ingest buffer flush on shutdown failed")
    await webhooks_sender.close_client()
    await engine.dispose()


# FastAPI のアプリ本体。API の仕様書（/docs など）は、開発時（debug）だけ公開する
app = FastAPI(
    title="FactorEye API",
    version="0.1.0",
    lifespan=start_and_stop,  # lifespan は FastAPI が決めた引数名（変えられない）
    # 本番では /docs /redoc /openapi.json を非公開にする（senhubの設計を踏襲）
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    openapi_url="/openapi.json" if settings.debug else None,
)

# 管理者が利用者として閲覧中（imp を持つトークン）の書き込みを、誰が・どこに行ったかをログに残す
# 読むだけで、データを変えないリクエストの種類（これらは記録しない）
READ_ONLY_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@app.middleware("http")
async def log_admin_changes(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    """すべてのリクエストの前に通る処理（ミドルウェア）。

    管理者が利用者として閲覧中（トークンに imp がある）に、データを変えたら、ログに残す。
    リクエストそのものは止めない。調べ終わったら、そのまま次の処理へ渡す。
    """
    if request.method not in READ_ONLY_METHODS:
        header = request.headers.get("authorization", "")
        if header.lower().startswith("bearer "):
            try:
                payload = decode_access_token(header[len("bearer ") :])
            except jwt.PyJWTError:
                payload = {}
            if "imp" in payload:
                logging.getLogger(__name__).warning(
                    "admin %s changed data as user %s: %s %s",
                    payload["imp"],
                    payload.get("sub"),
                    request.method,
                    request.url.path,
                )
    return await call_next(request)


# 取り込み API のレート制限（slowapi）。制限を超えたリクエストは 429 を返す
app.state.limiter = limiter
# slowapiのハンドラ型はStarletteの例外ハンドラ型と厳密には一致しない（ライブラリ側のstub起因）
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

# 422 の応答に、送られた値（パスワードなど）を含めない
app.add_exception_handler(RequestValidationError, handle_input_error)  # type: ignore[arg-type]

# CORS: 明示的にFRONTEND_URLのみ許可（`*`禁止、docs/architecture.md §11 運用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# API の窓口（router）を、アプリ本体（app）に登録する。
# なぜ必要か: 各ファイルの router は、「このパスに来たらこの処理」という対応表を持っているだけ。
# app に登録しないと、その URL にリクエストが来ても、アプリは存在を知らず 404 を返す。
# （読み込み: 上の from app.api import ... ／ 登録: ここ。2つで1組）
app.include_router(sensors.router)  # /api/sensors: センサーの管理
app.include_router(ingest.router)  # /api/ingest: 機器から測定値を受け取る
app.include_router(readings.router)  # /api/readings: 測定値の一覧
app.include_router(alarms.router)  # /api/alarms: アラームの一覧・確認
app.include_router(dashboards.router)  # /api/dashboards: ダッシュボード
app.include_router(widgets.router)  # /api/widgets: ダッシュボードの部品
app.include_router(alert_settings.router)  # /api/settings/notifications: Discord 通知の設定
app.include_router(migration.router)  # /api/settings/migration: SaaS から OSS への引っ越し
app.include_router(webhooks.router)  # /api/settings/webhooks: Webhook の通知先

# Phase 0.5: AUTH_MODE=multi_tenant（SaaS）のときだけ、ログイン・ユーザー・管理者の API を公開する。
# self-hosted（OSS）では、これらの API は登録されず、404 になる
if settings.auth_mode == AuthMode.MULTI_TENANT:
    app.include_router(auth.router)  # /api/auth/*: 登録・ログイン・ログアウト
    # 管理者API（管理者はテキストファイルで管理。app/admin_accounts.py 参照）
    app.include_router(admin.router)
    app.include_router(admin_failback.router)  # /api/admin/failback/*: 控えからの書き戻し


@app.get("/health")
async def health_check() -> dict[str, Any]:
    """死活監視用。DB に SELECT 1 を投げて、接続できるかを確かめる。

    DB に接続できなくても HTTP 200 のまま、status を "degraded" で返す（監視側で判定する）。
    """
    db_status = "connected"
    try:
        async with engine.connect() as conn:
            await conn.execute(text("SELECT 1"))
    except Exception:
        db_status = "disconnected"

    return {
        "status": "ok" if db_status == "connected" else "degraded",
        "timestamp": datetime.now(UTC).isoformat(),
        "services": {"database": db_status},
    }
