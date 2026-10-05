"""移行API（/api/settings/migration）のテスト。

SaaS（multi_tenant）と self-hosted の切り替えは monkeypatch で行う。
同じテストDBの中で、SaaS 側で書き出し → ワークスペース削除 → self-hosted 側で取り込み、を通す。
"""

from collections.abc import AsyncGenerator
from uuid import UUID

import httpx
import pytest
import pytest_asyncio
import sqlalchemy as sa
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.config import AuthMode, settings
from app.db.models import Sensor, User, Workspace
from app.db.session import engine
from app.main import app


@pytest_asyncio.fixture
async def alembic_table() -> AsyncGenerator[None, None]:
    async with engine.begin() as conn:
        await conn.execute(
            sa.text("CREATE TABLE alembic_version (version_num VARCHAR(32) NOT NULL)")
        )
        await conn.execute(sa.text("INSERT INTO alembic_version VALUES ('testrev')"))
    yield
    async with engine.begin() as conn:
        await conn.execute(sa.text("DROP TABLE alembic_version"))


@pytest_asyncio.fixture
async def workspace_id(alembic_table: None) -> AsyncGenerator[UUID, None]:
    async with AsyncSession(engine) as session:
        user = User(email="owner@example.com", password_hash="x")
        session.add(user)
        await session.flush()
        ws = Workspace(name="A", owner_id=user.id)
        session.add(ws)
        await session.flush()
        session.add(Sensor(workspace_id=ws.id, name="釜A温度", ingest_key="saas-key-a1", unit="℃"))
        ws_id = ws.id
        await session.commit()
    yield ws_id


async def _count(sql: str, **params: object) -> int:
    async with engine.connect() as conn:
        return int(await conn.scalar(sa.text(sql), params) or 0)


async def _remove_workspace(ws_id: UUID) -> None:
    async with engine.begin() as conn:
        await conn.execute(sa.text("DELETE FROM workspaces WHERE id = :id"), {"id": ws_id})


@pytest.fixture
def saas_mode(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)


@pytest.mark.asyncio
async def test_status_self_hosted_allows_import_only(client: httpx.AsyncClient) -> None:
    body = (await client.get("/api/settings/migration/status")).json()
    assert body == {"mode": "self_hosted", "canExport": False, "canImport": True}


@pytest.mark.asyncio
async def test_status_saas_allows_export_only(client: httpx.AsyncClient, saas_mode: None) -> None:
    body = (await client.get("/api/settings/migration/status")).json()
    assert body == {"mode": "multi_tenant", "canExport": True, "canImport": False}


@pytest.mark.asyncio
async def test_export_is_hidden_in_self_hosted(client: httpx.AsyncClient) -> None:
    response = await client.get("/api/settings/migration/export")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_import_is_hidden_in_saas(client: httpx.AsyncClient, saas_mode: None) -> None:
    response = await client.post("/api/settings/migration/import", content=b"")
    assert response.status_code == 404


@pytest.mark.asyncio
async def test_export_returns_the_logged_in_workspace(
    client: httpx.AsyncClient,
    saas_mode: None,
    workspace_id: UUID,
) -> None:
    app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id
    try:
        response = await client.get("/api/settings/migration/export")
    finally:
        app.dependency_overrides.pop(get_current_workspace_id, None)

    assert response.status_code == 200
    assert response.headers["content-type"] == "application/gzip"
    assert f"factoreye-workspace-{workspace_id}.jsonl.gz" in response.headers["content-disposition"]
    assert len(response.content) > 0


@pytest.mark.asyncio
async def test_export_then_import_moves_workspace(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    workspace_id: UUID,
) -> None:
    # 1. SaaS 側で書き出す
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id
    try:
        exported = await client.get("/api/settings/migration/export")
    finally:
        app.dependency_overrides.pop(get_current_workspace_id, None)
    assert exported.status_code == 200
    await _remove_workspace(workspace_id)

    # 2. self-hosted 側で取り込む（まず確認だけ）
    monkeypatch.setattr(settings, "auth_mode", AuthMode.DISABLED)
    dry = await client.post(
        "/api/settings/migration/import?dry_run=true",
        content=exported.content,
        headers={"Content-Type": "application/gzip"},
    )
    assert dry.status_code == 200
    assert dry.json()["dryRun"] is True
    assert dry.json()["counts"]["sensors"] == 1
    assert await _count("SELECT COUNT(*) FROM sensors") == 0

    # 3. 本番の取り込み
    real = await client.post(
        "/api/settings/migration/import",
        content=exported.content,
        headers={"Content-Type": "application/gzip"},
    )
    assert real.status_code == 200
    assert real.json()["dryRun"] is False
    assert await _count("SELECT COUNT(*) FROM sensors WHERE workspace_id IS NULL") == 1


@pytest.mark.asyncio
async def test_import_rejects_broken_file(client: httpx.AsyncClient) -> None:
    response = await client.post(
        "/api/settings/migration/import",
        content=b"this is not gzip",
        headers={"Content-Type": "application/gzip"},
    )
    assert response.status_code == 400
    assert "読めません" in response.json()["detail"]


@pytest.mark.asyncio
async def test_import_conflict_returns_409(
    client: httpx.AsyncClient,
    monkeypatch: pytest.MonkeyPatch,
    workspace_id: UUID,
) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id
    try:
        exported = await client.get("/api/settings/migration/export")
    finally:
        app.dependency_overrides.pop(get_current_workspace_id, None)

    # 書き出し元がまだ残っている状態で取り込むと、ID 重複で 409 になり、何も残らない
    monkeypatch.setattr(settings, "auth_mode", AuthMode.DISABLED)
    response = await client.post(
        "/api/settings/migration/import",
        content=exported.content,
        headers={"Content-Type": "application/gzip"},
    )
    assert response.status_code == 409
    assert await _count("SELECT COUNT(*) FROM sensors WHERE workspace_id IS NULL") == 0
