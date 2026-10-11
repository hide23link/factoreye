"""Webhook連携設定API（一覧・作成・更新・削除）。

docs/architecture.md §7 通知 参照。配信本体（app.webhooks.send_webhook）の
呼び出しはapp.ingest_buffer側の責務であり、ここは設定のCRUDのみを扱う。
"""

from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.updates import apply_update
from app.db.models import WebhookSubscription
from app.db.session import get_session
from app.schemas import (
    WebhookSubscriptionCreate,
    WebhookSubscriptionRead,
    WebhookSubscriptionUpdate,
)
from app.webhooks import UnsafeWebhookUrl, assert_webhook_url_allowed

router = APIRouter(prefix="/api/settings/webhooks", tags=["webhooks"])


async def _ensure_safe_url(url: str) -> None:
    """登録・変更時点でSSRF対策の検証を行い、NGなら422で理由を返す（送信時にも再検証する）。

    422 の理由（detail）は、画面に表示される（例: 「https のURLを指定してください」）。
    """
    try:
        await assert_webhook_url_allowed(url)
    except UnsafeWebhookUrl as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_CONTENT, detail=str(exc)
        ) from exc


async def _get_owned_subscription(
    session: AsyncSession, subscription_id: UUID, workspace_id: UUID | None
) -> WebhookSubscription:
    """自分のワークスペースの購読を1件取り出す。無い・他人のものは 404（存在を知らせない）。"""
    subscription = await session.get(WebhookSubscription, subscription_id)
    if subscription is None or subscription.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="webhook not found")
    return subscription


@router.get("", response_model=list[WebhookSubscriptionRead])
async def list_webhook_subscriptions(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> list[WebhookSubscription]:
    """購読の一覧。自分のワークスペースのものだけを返す（self-hosted は NULL のものを返す）。"""
    query = select(WebhookSubscription).where(WebhookSubscription.workspace_id == workspace_id)
    result = await session.exec(query)
    return list(result.all())


@router.post("", response_model=WebhookSubscriptionRead, status_code=status.HTTP_201_CREATED)
async def create_webhook_subscription(
    payload: WebhookSubscriptionCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> WebhookSubscription:
    """購読を作る。URL は登録時にも検証する（危険な URL は保存しない）。"""
    await _ensure_safe_url(payload.url)
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
    """購読の更新（URL・有効/無効）。URL を変えるときは、もう一度検証する。"""
    subscription = await _get_owned_subscription(session, subscription_id, workspace_id)
    if payload.url is not None:
        await _ensure_safe_url(payload.url)
    apply_update(subscription, payload, non_nullable=frozenset({"url", "enabled"}))
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
    """購読の削除（物理削除）。"""
    subscription = await _get_owned_subscription(session, subscription_id, workspace_id)
    await session.delete(subscription)
    await session.commit()
