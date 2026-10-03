"""ダッシュボード管理API（一覧/作成/詳細/更新/削除）とウィジェット追加。

ウィジェットの更新/削除は app.api.widgets（/api/widgets/:id、dashboard非依存）。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.db.models import Dashboard, Widget
from app.db.session import get_session
from app.schemas import (
    DashboardCreate,
    DashboardDetail,
    DashboardRead,
    DashboardUpdate,
    WidgetCreate,
    WidgetRead,
)

router = APIRouter(prefix="/api/dashboards", tags=["dashboards"])


async def _get_active_dashboard(
    session: AsyncSession, dashboard_id: UUID, workspace_id: UUID | None = None
) -> Dashboard:
    dashboard = await session.get(Dashboard, dashboard_id)
    if dashboard is None or dashboard.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dashboard not found")
    if workspace_id is not None and dashboard.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dashboard not found")
    return dashboard


async def _list_widgets(session: AsyncSession, dashboard_id: UUID) -> list[Widget]:
    result = await session.exec(select(Widget).where(Widget.dashboard_id == dashboard_id))
    return list(result.all())


def _to_detail(dashboard: Dashboard, widgets: list[Widget]) -> DashboardDetail:
    # dashboard.widgets（リレーション）には触れない: asyncセッション終了後のlazy-load回避のため、
    # 別途明示的にクエリしたwidgetsを渡して組み立てる
    return DashboardDetail(
        id=dashboard.id,
        name=dashboard.name,
        description=dashboard.description,
        layout_config=dashboard.layout_config,
        created_at=dashboard.created_at,
        updated_at=dashboard.updated_at,
        widgets=[WidgetRead.model_validate(w) for w in widgets],
    )


@router.get("", response_model=list[DashboardRead])
async def list_dashboards(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> list[Dashboard]:
    # SQLModelのクラス属性はmypyには素のPython型に見えるため.is_()はunion-attrで誤検知される
    query = select(Dashboard).where(Dashboard.deleted_at.is_(None))  # type: ignore[union-attr]
    if workspace_id is not None:
        query = query.where(Dashboard.workspace_id == workspace_id)
    result = await session.exec(query)
    return list(result.all())


@router.post("", response_model=DashboardDetail, status_code=status.HTTP_201_CREATED)
async def create_dashboard(
    payload: DashboardCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> DashboardDetail:
    dashboard = Dashboard(workspace_id=workspace_id, **payload.model_dump())
    session.add(dashboard)
    await session.commit()
    await session.refresh(dashboard)
    return _to_detail(dashboard, [])


@router.get("/{dashboard_id}", response_model=DashboardDetail)
async def get_dashboard(
    dashboard_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> DashboardDetail:
    dashboard = await _get_active_dashboard(session, dashboard_id, workspace_id)
    widgets = await _list_widgets(session, dashboard_id)
    return _to_detail(dashboard, widgets)


@router.put("/{dashboard_id}", response_model=DashboardDetail)
async def update_dashboard(
    dashboard_id: UUID,
    payload: DashboardUpdate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> DashboardDetail:
    dashboard = await _get_active_dashboard(session, dashboard_id, workspace_id)
    for field, value in payload.model_dump(exclude_unset=True).items():
        setattr(dashboard, field, value)
    dashboard.updated_at = datetime.now(UTC)
    session.add(dashboard)
    await session.commit()
    await session.refresh(dashboard)

    widgets = await _list_widgets(session, dashboard_id)
    return _to_detail(dashboard, widgets)


@router.delete("/{dashboard_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_dashboard(
    dashboard_id: UUID,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> None:
    dashboard = await _get_active_dashboard(session, dashboard_id, workspace_id)
    dashboard.deleted_at = datetime.now(UTC)
    session.add(dashboard)
    await session.commit()


@router.post(
    "/{dashboard_id}/widgets", response_model=WidgetRead, status_code=status.HTTP_201_CREATED
)
async def add_widget(
    dashboard_id: UUID,
    payload: WidgetCreate,
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> Widget:
    await _get_active_dashboard(session, dashboard_id, workspace_id)
    widget = Widget(dashboard_id=dashboard_id, **payload.model_dump())
    session.add(widget)
    await session.commit()
    await session.refresh(widget)
    return widget
