"""通知設定API（Discord Webhook URL・有効/無効）。シングルトン行（id=1）を1件だけ扱う。"""
from fastapi import APIRouter, Depends
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import NotificationSettings
from app.db.session import get_session
from app.schemas import NotificationSettingsRead, NotificationSettingsUpdate

router = APIRouter(prefix="/api/settings", tags=["settings"])


async def _get_notification_settings(session: AsyncSession) -> NotificationSettings:
    # マイグレーションでid=1の行を1件投入済みだが、テストはマイグレーションを通さず
    # SQLModel.metadata.create_allでスキーマを作るため、無ければここで作る（冪等）
    settings_row = await session.get(NotificationSettings, 1)
    if settings_row is None:
        settings_row = NotificationSettings(id=1)
        session.add(settings_row)
        await session.commit()
        await session.refresh(settings_row)
    return settings_row


@router.get("/notifications", response_model=NotificationSettingsRead)
async def get_notification_settings(
    session: AsyncSession = Depends(get_session),
) -> NotificationSettings:
    return await _get_notification_settings(session)


@router.put("/notifications", response_model=NotificationSettingsRead)
async def update_notification_settings(
    payload: NotificationSettingsUpdate, session: AsyncSession = Depends(get_session)
) -> NotificationSettings:
    settings_row = await _get_notification_settings(session)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(settings_row, field, value)
    session.add(settings_row)
    await session.commit()
    await session.refresh(settings_row)
    return settings_row
