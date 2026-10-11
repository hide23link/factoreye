"""通知設定API（Discord Webhook URL・有効/無効）。

self-hosted: workspace_id IS NULL の行（id=1）
multi-tenant: ワークスペースごとの行を自動作成
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import NotificationSettings
from app.db.session import get_session
from app.schemas import NotificationSettingsRead, NotificationSettingsUpdate
from app.webhooks import UnsafeWebhookUrl, assert_webhook_url_allowed

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
    changes = payload.model_dump(exclude_unset=True)
    # Discord の URL は、サーバーから POST する宛先なので、Webhook 購読と同じ SSRF 検証を通す
    # （空文字は「未設定」なので許可）。送信時にも再検証する
    for field in ("discord_webhook_url_critical", "discord_webhook_url_warning"):
        url = changes.get(field)
        if url:
            try:
                await assert_webhook_url_allowed(url)
            except UnsafeWebhookUrl as exc:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
                ) from exc

    settings_row = await _get_notification_settings(session, workspace_id)
    for field, value in changes.items():
        setattr(settings_row, field, value)
    session.add(settings_row)
    await session.commit()
    await session.refresh(settings_row)
    return settings_row
