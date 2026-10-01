"""DBエンジン・セッション管理（asyncpg + SQLModel/SQLAlchemy 2.0 async）。"""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession as SQLModelAsyncSession

from app.config import settings

engine = create_async_engine(
    settings.database_url, echo=settings.debug, pool_size=5, max_overflow=5
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    async with SQLModelAsyncSession(engine) as session:
        yield session
