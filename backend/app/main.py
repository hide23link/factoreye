"""
FactorEye バックエンド エントリポイント

起動方法:
    uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload   # 開発
    uvicorn app.main:app --host 0.0.0.0 --port 8000             # 本番（docker-compose経由）
"""
import asyncio
from collections.abc import AsyncIterator
from contextlib import asynccontextmanager
from datetime import UTC, datetime
from typing import Any

from fastapi import FastAPI
from slowapi import _rate_limit_exceeded_handler
from slowapi.errors import RateLimitExceeded
from sqlalchemy import text

from app.api import alarms, dashboards, ingest, readings, sensors, widgets
from app.config import settings
from app.db.session import engine
from app.ingest_buffer import flush_loop
from app.rate_limit import limiter


@asynccontextmanager
async def lifespan(app: FastAPI) -> AsyncIterator[None]:
    flush_task = asyncio.create_task(flush_loop())
    yield
    flush_task.cancel()
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

app.state.limiter = limiter
# slowapiのハンドラ型はStarletteの例外ハンドラ型と厳密には一致しない（ライブラリ側のstub起因）
app.add_exception_handler(RateLimitExceeded, _rate_limit_exceeded_handler)  # type: ignore[arg-type]

app.include_router(sensors.router)
app.include_router(ingest.router)
app.include_router(readings.router)
app.include_router(alarms.router)
app.include_router(dashboards.router)
app.include_router(widgets.router)


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
