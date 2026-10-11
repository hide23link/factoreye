"""通知設定API（Discord Webhook URL・有効/無効）。

self-hosted: workspace_id IS NULL の行（id=1）
multi-tenant: ワークスペースごとの行を自動作成
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.updates import apply_update
from app.db.models import NotificationSettings
from app.db.session import get_session
from app.schemas import NotificationSettingsRead, NotificationSettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


async def _get_notification_settings(
    session: AsyncSession, workspace_id: UUID | None
) -> NotificationSettings:
    """通知設定を取り出す。無ければ、既定の値で1行作ってから返す（初回の表示を失敗させないため）。"""
    if workspace_id is None:
        # self-hosted: workspace_id IS NULL の行（id=1。なければ初期作成）
        settings_row = await session.get(NotificationSettings, 1)
        if settings_row is None:
            settings_row = NotificationSettings(id=1, workspace_id=None)
            session.add(settings_row)
            await session.commit()
            await session.refresh(settings_row)
    else:
        # multi-tenant: workspace_id 別の行を取得または作成
        result = await session.exec(
            select(NotificationSettings).where(
                NotificationSettings.workspace_id == workspace_id
            )
        )
        settings_row = result.first()
        if settings_row is None:
            settings_row = NotificationSettings(workspace_id=workspace_id)
            session.add(settings_row)
            await session.commit()
            await session.refresh(settings_row)
    return settings_row


@router.get("/notifications", response_model=NotificationSettingsRead)
async def get_notification_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> NotificationSettings:
    """通知設定の取得（Discord の URL・有効/無効・重故障の再通知）。"""
    return await _get_notification_settings(session, workspace_id)


@router.put("/notifications", response_model=NotificationSettingsRead)
async def update_notification_settings(
    payload: NotificationSettingsUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> NotificationSettings:
    """通知設定の更新。送られた項目だけを変える。"""
    settings_row = await _get_notification_settings(session, workspace_id)
    apply_update(
        settings_row,
        payload,
        non_nullable=frozenset(
            {
                "discord_webhook_url_critical",
                "discord_webhook_url_warning",
                "enabled",
                "critical_repeat_enabled",
                "critical_repeat_interval_minutes",
            }
        ),
    )
    session.add(settings_row)
    await session.commit()
    await session.refresh(settings_row)
    return settings_row
