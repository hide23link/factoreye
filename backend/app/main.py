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
from app.api import (
    admin,
    alarms,
    auth,
    dashboards,
    ingest,
    migration,
    readings,
    sensors,
    webhooks,
    widgets,
)
from app.api import settings as settings_api
from app.auth import decode_access_token
from app.config import AuthMode, settings
from app.db.session import engine
from app.ingest_buffer import flush_loop, flush_once
from app.purge import purge_loop
from app.rate_limit import limiter
from app.validation import validation_error_handler


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
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
    lifespan=lifespan,
    # 本番では /docs /redoc /openapi.json を非公開にする（senhubの設計を踏襲）
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    openapi_url="/openapi.json" if settings.debug else None,
)

# 管理者が利用者として閲覧中（imp を持つトークン）の書き込みを、誰が・どこに行ったかをログに残す
_READ_METHODS = frozenset({"GET", "HEAD", "OPTIONS"})


@app.middleware("http")
async def log_impersonated_writes(
    request: Request, call_next: Callable[[Request], Awaitable[Response]]
) -> Response:
    if request.method not in _READ_METHODS:
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
app.add_exception_handler(RequestValidationError, validation_error_handler)  # type: ignore[arg-type]

# CORS: 明示的にFRONTEND_URLのみ許可（`*`禁止、docs/architecture.md §11 運用）
app.add_middleware(
    CORSMiddleware,
    allow_origins=[settings.frontend_url],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(sensors.router)
app.include_router(ingest.router)
app.include_router(readings.router)
app.include_router(alarms.router)
app.include_router(dashboards.router)
app.include_router(widgets.router)
app.include_router(settings_api.router)
app.include_router(migration.router)
app.include_router(webhooks.router)

# Phase 0.5: AUTH_MODE=multi_tenant（SaaS）のときだけ、ログイン・ユーザー・管理者の API を公開する。
# self-hosted（OSS）では、これらの API は登録されず、404 になる
if settings.auth_mode == AuthMode.MULTI_TENANT:
    app.include_router(auth.router)
    # 管理者API（管理者はテキストファイルで管理。app/admin_accounts.py 参照）
    app.include_router(admin.router)


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
