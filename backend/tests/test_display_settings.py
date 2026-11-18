"""画面の明るさの全員の初期値 API（/api/settings/display）のテスト。id=1 の行の読み書き。"""
from collections.abc import Iterator
from typing import Any
from uuid import UUID, uuid4

import httpx
import pytest

from app.api.deps import get_current_workspace_id
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
