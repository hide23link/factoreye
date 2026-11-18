"""画面の明るさの全員の初期値 API（/api/settings/display）のテスト。id=1 の行の読み書き。"""
import asyncio
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest
from sqlalchemy import func
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import DisplaySettings
from app.db.session import engine
from app.main import app


@pytest.fixture
def as_workspace() -> Iterator[Any]:
    """依存関係を差し替え、テスト中に別のワークスペースとして振る舞えるようにする。"""

    def _set(workspace_id: UUID | None) -> None:
        app.dependency_overrides[get_current_workspace_id] = lambda: workspace_id

    yield _set
    app.dependency_overrides.pop(get_current_workspace_id, None)


async def test_get_display_settings_defaults_to_dark(client: httpx.AsyncClient) -> None:
    resp = await client.get("/api/settings/display")
    assert resp.status_code == 200
    assert resp.json() == {"defaultTheme": "dark"}


async def test_update_display_settings(client: httpx.AsyncClient) -> None:
    resp = await client.put("/api/settings/display", json={"defaultTheme": "light"})
    assert resp.status_code == 200
    assert resp.json() == {"defaultTheme": "light"}

    got = await client.get("/api/settings/display")
    assert got.json() == {"defaultTheme": "light"}

    # もう一度変えても、行は 1 つのまま（上書き）
    await client.put("/api/settings/display", json={"defaultTheme": "system"})
    assert (await client.get("/api/settings/display")).json() == {"defaultTheme": "system"}


async def test_update_display_settings_rejects_unknown_theme(client: httpx.AsyncClient) -> None:
    resp = await client.put("/api/settings/display", json={"defaultTheme": "blue"})
    assert resp.status_code == 422


async def test_update_display_settings_rejects_missing_or_null(client: httpx.AsyncClient) -> None:
    assert (await client.put("/api/settings/display", json={})).status_code == 422
    resp = await client.put("/api/settings/display", json={"defaultTheme": None})
    assert resp.status_code == 422


async def test_display_default_is_separate_per_workspace(
    client: httpx.AsyncClient, as_workspace: Any
) -> None:
    """SaaS: ワークスペースごとに別の行。片方で変えても、もう片方は変わらない。"""
    ws_a, ws_b = uuid4(), uuid4()
    as_workspace(ws_a)
    resp = await client.put("/api/settings/display", json={"defaultTheme": "light"})
    assert resp.status_code == 200

    as_workspace(ws_b)
    assert (await client.get("/api/settings/display")).json() == {"defaultTheme": "dark"}

    as_workspace(ws_a)
    assert (await client.get("/api/settings/display")).json() == {"defaultTheme": "light"}


async def _put(client: httpx.AsyncClient, theme: str) -> httpx.Response:
    return await client.put("/api/settings/display", json={"defaultTheme": theme})


async def _row_count() -> int:
    async with AsyncSession(engine) as session:
        result = await session.exec(select(func.count()).select_from(DisplaySettings))
        return int(result.one())


async def test_get_does_not_create_a_row(client: httpx.AsyncClient) -> None:
    """読むだけでは行を作らない（既定を返すだけ）。最初の PUT で初めて作る。"""
    assert (await client.get("/api/settings/display")).json() == {"defaultTheme": "dark"}
    assert (await client.get("/api/settings/display")).json() == {"defaultTheme": "dark"}
    assert await _row_count() == 0

    await client.put("/api/settings/display", json={"defaultTheme": "light"})
    assert await _row_count() == 1
    await client.put("/api/settings/display", json={"defaultTheme": "dark"})
    assert await _row_count() == 1


async def test_concurrent_first_puts_do_not_conflict(client: httpx.AsyncClient) -> None:
    """行が無いところへ同時に最初の保存が来ても、どちらも成功し、行は 1 つだけ。"""
    themes = ("light", "system", "dark", "light")
    responses = await asyncio.gather(*(_put(client, theme) for theme in themes))
    assert [r.status_code for r in responses] == [200, 200, 200, 200]
    assert await _row_count() == 1
    got = (await client.get("/api/settings/display")).json()
    assert got["defaultTheme"] in {"light", "system", "dark"}


async def test_concurrent_first_puts_per_workspace(
    client: httpx.AsyncClient, as_workspace: Any
) -> None:
    """SaaS: 同じワークスペースの同時の最初の保存でも、行は 1 つ（ぶつかれば更新に切り替える）。"""
    as_workspace(uuid4())
    themes = ("light", "system", "light")
    responses = await asyncio.gather(*(_put(client, theme) for theme in themes))
    assert [r.status_code for r in responses] == [200, 200, 200]
    assert await _row_count() == 1
