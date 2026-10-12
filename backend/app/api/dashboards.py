"""ダッシュボード管理API（一覧/作成/詳細/更新/削除）とウィジェット追加。

ウィジェットの更新/削除は app.api.widgets（/api/widgets/:id、dashboard非依存）。

【呼ばれ方】画面が呼ぶ（ダッシュボード ＝ ウィジェットを並べた1つの画面）。
- GET    /api/dashboards                       → 一覧
- POST   /api/dashboards  本文: {"name": "工場A"} → 作る
- GET    /api/dashboards/{dashboard_id}        → 1件（ウィジェット付き）
- PUT    /api/dashboards/{dashboard_id}        → 変えたい項目だけ更新
- DELETE /api/dashboards/{dashboard_id}        → 削除（行は残る。論理削除）
- POST   /api/dashboards/{dashboard_id}/widgets → ウィジェットを追加
【引数】session（DB との会話）と workspace_id（SaaS のとき、ログイン中の利用者のワークスペース。
self-hosted では None）は、呼び出す人が渡すものではない。FastAPI が Depends で自動で渡す。
"""
from datetime import UTC, datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.api.deps import get_current_workspace_id
from app.api.sensors import _get_active_sensor
from app.api.updates import apply_update
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
    """ダッシュボードを1件取り出す。削除済み（論理削除）・他のワークスペースのものは 404。"""
    dashboard = await session.get(Dashboard, dashboard_id)
    if dashboard is None or dashboard.deleted_at is not None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dashboard not found")
    if workspace_id is not None and dashboard.workspace_id != workspace_id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="dashboard not found")
    return dashboard


async def _list_widgets(session: AsyncSession, dashboard_id: UUID) -> list[Widget]:
    """ダッシュボードに属するウィジェットの一覧。"""
    result = await session.exec(select(Widget).where(Widget.dashboard_id == dashboard_id))
    return list(result.all())


def _to_detail(dashboard: Dashboard, widgets: list[Widget]) -> DashboardDetail:
    """ダッシュボードとウィジェットから、応答用の詳細の形を組み立てる。"""
    # dashboard.widgets（リレーション）には触れない: asyncセッション終了後のlazy-load回避のため、
    # 別途明示的にクエリしたwidgetsを渡して組み立てる
    return DashboardDetail(
        id=dashboard.id,
        name=dashboard.name,
        description=dashboard.description,
        layout_config=dashboard.layout_config,
        created_at=dashboard.created_at,
        updated_at=dashboard.updated_at,
        widgets=[WidgetRead.model_validate(widget) for widget in widgets],
    )


@router.get("", response_model=list[DashboardRead])
async def list_dashboards(
    session: Annotated[AsyncSession, Depends(get_session)],
    workspace_id: Annotated[UUID | None, Depends(get_current_workspace_id)],
) -> list[Dashboard]:
    """ダッシュボードの一覧（削除済みを除く）。"""
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
    """ダッシュボードを作る（ウィジェットは、後から追加する）。"""
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
    """ダッシュボードの更新。送られた項目だけを変える。"""
    dashboard = await _get_active_dashboard(session, dashboard_id, workspace_id)
    apply_update(dashboard, payload, non_nullable=frozenset({"name", "layout_config"}))
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
    """ダッシュボードを論理削除する（deleted_at を入れるだけ。行は残る）。

    論理削除にするのは、ID の衝突を避けて、同じワークスペースの取り込み直しの扱いを単純にするため。
    """
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
    """ダッシュボードにウィジェットを1つ追加する。"""
    await _get_active_dashboard(session, dashboard_id, workspace_id)
    if payload.sensor_id is not None:
        await _get_active_sensor(session, payload.sensor_id, workspace_id)
    widget = Widget(dashboard_id=dashboard_id, **payload.model_dump())
    session.add(widget)
    await session.commit()
    await session.refresh(widget)
    return widget
