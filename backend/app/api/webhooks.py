"""Webhook連携設定API（一覧・作成・更新・削除）。

docs/factoreye-architecture.md §Webhook通知 参照。配信本体（app.webhooks.send_webhook）の
呼び出しはapp.ingest_buffer側の責務であり、ここは設定のCRUDのみを扱う。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import WebhookSubscription
from app.db.session import get_session
from app.schemas import (
    WebhookSubscriptionCreate,
    WebhookSubscriptionRead,
    WebhookSubscriptionUpdate,
)

router = APIRouter(prefix="/api/settings/webhooks", tags=["webhooks"])


async def _get_owned_subscription(
    session: AsyncSession, subscription_id: UUID, workspace_id: UUID | None
) -> WebhookSubscription:
    subscription = await session.get(WebhookSubscription, subscription_id)
    if subscription is None or subscription.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="webhook not found")
    return subscription


@router.get("", response_model=list[WebhookSubscriptionRead])
async def list_webhook_subscriptions(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> list[WebhookSubscription]:
    query = select(WebhookSubscription).where(WebhookSubscription.workspace_id == workspace_id)
    result = await session.exec(query)
    return list(result.all())


@router.post("", response_model=WebhookSubscriptionRead, status_code=status.HTTP_201_CREATED)
async def create_webhook_subscription(
    payload: WebhookSubscriptionCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> WebhookSubscription:
    subscription = WebhookSubscription(workspace_id=workspace_id, **payload.model_dump())
    session.add(subscription)
    await session.commit()
    await session.refresh(subscription)
    return subscription


@router.put("/{subscription_id}", response_model=WebhookSubscriptionRead)
async def update_webhook_subscription(
    subscription_id: UUID,
    payload: WebhookSubscriptionUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> WebhookSubscription:
    subscription = await _get_owned_subscription(session, subscription_id, workspace_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(subscription, field, value)
    subscription.updated_at = datetime.now(UTC)
    session.add(subscription)
    await session.commit()
    await session.refresh(subscription)
    return subscription


@router.delete("/{subscription_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_webhook_subscription(
    subscription_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> None:
    subscription = await _get_owned_subscription(session, subscription_id, workspace_id)
    await session.delete(subscription)
    await session.commit()
