"""ウィジェット更新・削除API（追加は app.api.dashboards の POST /api/dashboards/:id/widgets）。"""
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import Widget
from app.db.session import get_session
from app.schemas import WidgetRead, WidgetUpdate

router = APIRouter(prefix="/api/widgets", tags=["widgets"])


async def _get_widget(session: AsyncSession, widget_id: UUID) -> Widget:
    widget = await session.get(Widget, widget_id)
    if widget is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="widget not found")
    return widget


@router.put("/{widget_id}", response_model=WidgetRead)
async def update_widget(
    widget_id: UUID, payload: WidgetUpdate, session: AsyncSession = Depends(get_session)
) -> Widget:
    widget = await _get_widget(session, widget_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(widget, field, value)
    session.add(widget)
    await session.commit()
    await session.refresh(widget)
    return widget


@router.delete("/{widget_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_widget(widget_id: UUID, session: AsyncSession = Depends(get_session)) -> None:
    widget = await _get_widget(session, widget_id)
    await session.delete(widget)
    await session.commit()
