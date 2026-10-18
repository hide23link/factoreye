"""ウィジェット更新・削除API（追加は app.api.dashboards の POST /api/dashboards/:id/widgets）。

【呼ばれ方】画面のダッシュボードが呼ぶ（ウィジェット ＝ グラフや数値の表示部品）。
- PUT    /api/widgets/{widget_id}  本文: 変えたい項目だけ（位置・サイズ・センサー・設定）
- DELETE /api/widgets/{widget_id}
【引数】session（DB との会話）と workspace_id（SaaS のとき、ログイン中の利用者のワークスペース。
self-hosted では None）は、呼び出す人が渡すものではない。FastAPI が Depends で自動で渡す。
"""
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.sensors import _get_active_sensor as _get_sensor
from app.api.updates import apply_update
from app.db.models import Dashboard, Widget
from app.db.session import get_session
from app.schemas import WidgetRead, WidgetUpdate

router = APIRouter(prefix="/api/widgets", tags=["widgets"])


async def _get_widget(
    session: AsyncSession, widget_id: UUID, workspace_id: UUID | None = None
) -> Widget:
    """ウィジェットを1件取り出す。無い・他のワークスペースのものは 404。"""
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
    """ウィジェットの更新（位置・サイズ・設定など）。送られた項目だけを変える。"""
    widget = await _get_widget(session, widget_id, workspace_id)
    if payload.sensor_id is not None:
        await _get_sensor(session, payload.sensor_id, workspace_id)
    apply_update(
        widget,
        payload,
        non_nullable=frozenset(
            {"grid_column", "grid_row", "grid_width", "grid_height", "config"}
        ),
    )
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
    """ウィジェットの削除（物理削除）。"""
    widget = await _get_widget(session, widget_id, workspace_id)
    await session.delete(widget)
    await session.commit()
