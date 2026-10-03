"""ウィジェット更新・削除API（追加は app.api.dashboards の POST /api/dashboards/:id/widgets）。"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Dashboard, Widget
from app.db.session import get_session
from app.schemas import WidgetRead, WidgetUpdate

router = APIRouter(prefix="/api/widgets", tags=["widgets"])


async def _get_widget(
    session: AsyncSession, widget_id: UUID, workspace_id: UUID | None = None
) -> Widget:
    widget = await session.get(Widget, widget_id)
    if widget is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="widget not found")
    # multi-tenant: ダッシュボード経由でワークスペース所有確認
    if workspace_id is not None:
        dashboard = await session.get(Dashboard, widget.dashboard_id)
        if dashboard is None or dashboard.workspace_id != workspace_id:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="widget not found")
    return widget


@router.put("/{widget_id}", response_model=WidgetRead)
async def update_widget(
    widget_id: UUID,
    payload: WidgetUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Widget:
    widget = await _get_widget(session, widget_id, workspace_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(widget, field, value)
    session.add(widget)
    await session.commit()
    await session.refresh(widget)
    return widget


@router.delete("/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(
    widget_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> None:
    widget = await _get_widget(session, widget_id, workspace_id)
    await session.delete(widget)
    await session.commit()
