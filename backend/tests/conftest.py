"""共通テストフィクスチャ: スキーマ作成/クリーンアップ、APIクライアント。

DATABASE_URL は CI の postgres service / docker-compose の postgres を指す
（backend/.env.example のデフォルト値と同じ認証情報）。
"""
from collections.abc import AsyncGenerator

import httpx
import pytest_asyncio
from httpx import ASGITransport
from sqlmodel import SQLModel

from app.db.session import engine
from app.main import app


@pytest_asyncio.fixture(scope="session", autouse=True)
async def _schema() -> AsyncGenerator[None, None]:
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.create_all)
    yield
    async with engine.begin() as conn:
        await conn.run_sync(SQLModel.metadata.drop_all)


@pytest_asyncio.fixture(autouse=True)
async def _clean_tables() -> AsyncGenerator[None, None]:
    yield
    async with engine.begin() as conn:
        for table in reversed(SQLModel.metadata.sorted_tables):
            await conn.execute(table.delete())


@pytest_asyncio.fixture
async def client() -> AsyncGenerator[httpx.AsyncClient, None]:
    transport = ASGITransport(app=app)
    async with httpx.AsyncClient(transport=transport, base_url="http://test") as c:
        yield c
