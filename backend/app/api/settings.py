"""通知設定API（Discord Webhook URL・有効/無効）。

self-hosted: workspace_id IS NULL のシングルトン行（id=1）
multi-tenant: workspace_id 別の行を自動作成
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import NotificationSettings
from app.db.session import get_session
from app.schemas import NotificationSettingsRead, NotificationSettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


async def _get_notification_settings(
    session: AsyncSession, workspace_id: UUID | None
) -> NotificationSettings:
    if workspace_id is None:
        # self-hosted: id=1 のシングルトン行（マイグレーションで投入済み、なければ初期作成）
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
    return await _get_notification_settings(session, workspace_id)


@router.put("/notifications", response_model=NotificationSettingsRead)
async def update_notification_settings(
    payload: NotificationSettingsUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> NotificationSettings:
    settings_row = await _get_notification_settings(session, workspace_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings_row, field, value)
    session.add(settings_row)
    await session.commit()
    await session.refresh(settings_row)
    return settings_row
