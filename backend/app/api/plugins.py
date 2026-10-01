"""プラグイン管理API: 一覧・有効化/無効化・設定更新。

discoveryとlifecycle本体は app.plugins.manager が持つ。ここはHTTPの薄い窓口。
"""
from fastapi import APIRouter, Depends, Request
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Plugin
from app.db.session import get_session
from app.plugins import manager
from app.schemas import PluginConfigUpdate, PluginRead

router = APIRouter(prefix="/api/plugins", tags=["plugins"])


@router.get("", response_model=list[PluginRead])
async def list_plugins(session: AsyncSession = Depends(get_session)) -> list[Plugin]:
    result = await session.exec(select(Plugin))
    return list(result.all())


@router.patch("/{name}/enable", response_model=PluginRead)
async def enable_plugin(
    name: str, request: Request, session: AsyncSession = Depends(get_session)
) -> Plugin:
    return await manager.enable_plugin(request.app, session, name)


@router.patch("/{name}/disable", response_model=PluginRead)
async def disable_plugin(name: str, session: AsyncSession = Depends(get_session)) -> Plugin:
    return await manager.disable_plugin(session, name)


@router.put("/{name}/config", response_model=PluginRead)
async def update_plugin_config(
    name: str, payload: PluginConfigUpdate, session: AsyncSession = Depends(get_session)
) -> Plugin:
    return await manager.update_plugin_config(session, name, payload.config)
