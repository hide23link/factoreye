"""
FactorEye バックエンド エントリポイント

起動方法:
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload   # 開発
    uvicorn app.main:app --host 0.0.0.0 --port 8000             # 本番（docker-compose経由）
"""
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from sqlalchemy import text

from app.config import settings
from app.db.session import engine


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    yield
    await engine.dispose()


app = FastAPI(
    title="FactorEye API",
    version="0.1.0",
    lifespan=lifespan,
    # 本番では /docs /redoc /openapi.json を非公開にする（senhubの設計を踏襲）
    docs_url="/docs" if settings.debug else None,
    redoc_url="/redoc" if settings.debug else None,
    openapi_url="/openapi.json" if settings.debug else None,
)


@app.get("/health")
async def health_check() -> dict[str, Any]:
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
