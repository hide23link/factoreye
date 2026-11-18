"""通知設定API（Discord Webhook URL・有効/無効）。

self-hosted: workspace_id IS NULL の行（id=1）
multi-tenant: ワークスペースごとの行を自動作成

【呼ばれ方】画面の「設定」が呼ぶ。
- GET /api/settings/notifications  → 今の通知設定
- PUT /api/settings/notifications  本文: 変えたい項目だけ（例: {"enabled": false}）
- GET /api/settings/display        → 画面の明るさの、全員の初期値（{"defaultTheme": "dark"}）
- PUT /api/settings/display        本文: {"defaultTheme": "light"}（dark / light / system）
【引数】session（DB との会話）と workspace_id（SaaS のとき、ログイン中の利用者のワークスペース。
self-hosted では None）は、呼び出す人が渡すものではない。FastAPI が Depends で自動で渡す。
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.updates import apply_update
from app.db.models import DisplaySettings, NotificationSettings
from app.db.session import get_session
from app.schemas import (
    DisplaySettingsRead,
    DisplaySettingsUpdate,
    NotificationSettingsRead,
    NotificationSettingsUpdate,
)
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
            except UnsafeWebhookUrl as error:
                raise HTTPException(
                    status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(error)
                ) from error

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


async def _get_display_settings(
    session: AsyncSession, workspace_id: UUID | None
) -> DisplaySettings:
    """画面の明るさの初期値を取り出す。無ければ、既定（暗い）の行を作ってから返す。

    self-hosted は workspace_id IS NULL の行（id=1）、SaaS はワークスペースごとに 1 行。
    """
    if workspace_id is None:
        row = await session.get(DisplaySettings, 1)
        if row is None:
            row = DisplaySettings(id=1, workspace_id=None)
            session.add(row)
            await session.commit()
            await session.refresh(row)
        return row
    result = await session.exec(
        select(DisplaySettings).where(DisplaySettings.workspace_id == workspace_id)
    )
    row = result.first()
    if row is None:
        row = DisplaySettings(workspace_id=workspace_id)
        session.add(row)
        await session.commit()
        await session.refresh(row)
    return row


@router.get("/display", response_model=DisplaySettingsRead)
async def get_display_settings(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> DisplaySettings:
    """画面の明るさの、全員の初期値。自分で選んだ端末は、その選択が優先される（画面側で決める）。"""
    return await _get_display_settings(session, workspace_id)


@router.put("/display", response_model=DisplaySettingsRead)
async def update_display_settings(
    payload: DisplaySettingsUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> DisplaySettings:
    """画面の明るさの、全員の初期値を変える。

    通知などほかの設定と同じ権限（SaaS はログイン中の利用者のワークスペースだけ）。
    """
    row = await _get_display_settings(session, workspace_id)
    apply_update(row, payload, non_nullable=frozenset({"default_theme"}))
    session.add(row)
    await session.commit()
    await session.refresh(row)
    return row
