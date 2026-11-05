"""DB エンジン・セッション管理（asyncpg + SQLModel/SQLAlchemy 2.0 async）。

- engine: DB への接続の入口。接続は「プール」で使い回す（毎回つなぎ直さない）
- get_session: API の処理ごとに1つのセッションを渡す依存関係（FastAPI の Depends で使う）

【誰が使うか】
- get_session: api/ の各ファイルが、`session = Depends(get_session)` と書くと、FastAPI が
  リクエストごとに呼んで、できた session を引数に入れる（自分で呼ぶ必要はない）
- engine: ingest_buffer.py（flush のとき）、main.py（/health と停止時）が、直接使う
- セッション ＝ DB との会話1回分。処理が終わったら閉じる
"""
from collections.abc import AsyncGenerator

from sqlalchemy.ext.asyncio import AsyncSession, create_async_engine
from sqlmodel.ext.asyncio.session import AsyncSession as SQLModelAsyncSession

from app.config import settings

# 接続プール: 通常は5本を保ち、混雑時はさらに5本まで増やす（合計最大10本）。
# echo=True（開発時）は、実行される SQL をログに出す
engine = create_async_engine(
    settings.database_url, echo=settings.debug, pool_size=5, max_overflow=5
)


async def get_session() -> AsyncGenerator[AsyncSession, None]:
    """API の処理1回分の DB セッションを渡す。処理が終わると、自動で閉じられる。

    使い方（API の関数の引数）: session: Annotated[AsyncSession, Depends(get_session)]
    """
    async with SQLModelAsyncSession(engine) as session:
        yield session
