"""管理者 API（/api/admin、AUTH_MODE=multi_tenant 時のみ main.py でマウント）。

管理者アカウントは DB ではなくテキストファイル（app.admin_accounts）で管理する。

エンドポイント:
  POST   /api/admin/login            → 管理者トークン発行（ID + パスワード、レート制限あり）
  GET    /api/admin/overview         → 全体の件数・DB使用量
  GET    /api/admin/users            → 全ユーザーの一覧（センサー数・測定件数・最終測定時刻）
  GET    /api/admin/users/{id}       → ユーザー詳細（ワークスペースのセンサー別状況）
  PATCH  /api/admin/users/{id}       → メール・プラン・パスワードの修正
  DELETE /api/admin/users/{id}       → ユーザーと関連データを物理削除
"""

import logging
from datetime import datetime
from typing import Annotated, Literal
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from pydantic import EmailStr, Field
from sqlalchemy import delete, func, text
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import admin_accounts
from app import auth as auth_utils
from app.api.deps import require_admin
from app.db.models import (
    Alarm,
    AlarmStatus,
    Dashboard,
    NotificationSettings,
    Reading,
    RefreshToken,
    Sensor,
    User,
    Widget,
    WidgetConfig,
    Workspace,
)
from app.db.session import get_session
from app.rate_limit import limiter
from app.schemas import CamelModel

router = APIRouter(prefix="/api/admin", tags=["admin"])
_logger = logging.getLogger(__name__)


# ── スキーマ ──────────────────────────────────────────────────


class AdminLoginRequest(CamelModel):
    admin_id: str = Field(min_length=1, max_length=50)
    password: str = Field(min_length=1, max_length=200)


class AdminTokenResponse(CamelModel):
    access_token: str
    token_type: str = "bearer"


class AdminOverview(CamelModel):
    user_count: int
    workspace_count: int
    sensor_count: int
    reading_count: int
    database_size_bytes: int


class AdminUserSummary(CamelModel):
    id: UUID
    email: str
    created_at: datetime
    workspace_id: UUID | None
    workspace_name: str | None
    plan: str | None
    sensor_count: int
    reading_count: int
    last_reading_at: datetime | None


class AdminSensorSummary(CamelModel):
    id: UUID
    name: str
    unit: str
    enabled: bool
    reading_count: int
    last_reading_at: datetime | None
    active_alarm_count: int


class AdminUserDetail(AdminUserSummary):
    sensors: list[AdminSensorSummary]


class AdminUserUpdate(CamelModel):
    email: EmailStr | None = None
    plan: Literal["free", "pro"] | None = None
    # 指定時はパスワードを再設定し、既存のリフレッシュトークンを全て失効させる
    password: str | None = Field(default=None, min_length=8, max_length=100)


# ── 内部ヘルパー ──────────────────────────────────────────────


async def _load_user_summaries(
    session: AsyncSession, *, user_id: UUID | None = None
) -> list[AdminUserSummary]:
    """ユーザー（＋ワークスペース）と、そのワークスペースの集計を組み立てる。
    集計はワークスペース単位の GROUP BY を 2 本だけ流す（ユーザー数に比例して
    クエリを増やさない）。"""
    query = (
        select(User, Workspace)
        .outerjoin(Workspace, col(Workspace.owner_id) == col(User.id))
        .order_by(col(User.created_at))
    )
    if user_id is not None:
        query = query.where(col(User.id) == user_id)
    rows = (await session.exec(query)).all()

    workspace_ids = [ws.id for _, ws in rows if ws is not None]
    sensor_counts: dict[UUID, int] = {}
    reading_stats: dict[UUID, tuple[int, datetime | None]] = {}
    if workspace_ids:
        sensor_rows = await session.exec(
            select(col(Sensor.workspace_id), func.count(col(Sensor.id)))
            .where(col(Sensor.workspace_id).in_(workspace_ids))
            .group_by(col(Sensor.workspace_id))
        )
        for ws_id, count in sensor_rows.all():
            if ws_id is not None:
                sensor_counts[ws_id] = count

        reading_rows = await session.exec(
            select(
                col(Sensor.workspace_id),
                func.count(col(Reading.id)),
                func.max(col(Reading.recorded_at)),
            )
            .join(Reading, col(Reading.sensor_id) == col(Sensor.id))
            .where(col(Sensor.workspace_id).in_(workspace_ids))
            .group_by(col(Sensor.workspace_id))
        )
        for ws_id, count, last_at in reading_rows.all():
            if ws_id is not None:
                reading_stats[ws_id] = (count, last_at)

    summaries: list[AdminUserSummary] = []
    for user, ws in rows:
        ws_id = ws.id if ws is not None else None
        stat: tuple[int, datetime | None] = (
            reading_stats.get(ws_id, (0, None)) if ws_id else (0, None)
        )
        summaries.append(
            AdminUserSummary(
                id=user.id,
                email=user.email,
                created_at=user.created_at,
                workspace_id=ws_id,
                workspace_name=ws.name if ws is not None else None,
                plan=ws.plan if ws is not None else None,
                sensor_count=sensor_counts.get(ws_id, 0) if ws_id else 0,
                reading_count=stat[0],
                last_reading_at=stat[1],
            )
        )
    return summaries


async def _get_user_or_404(session: AsyncSession, user_id: UUID) -> User:
    user = await session.get(User, user_id)
    if user is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")
    return user


# ── エンドポイント ────────────────────────────────────────────


@router.post("/login", response_model=AdminTokenResponse)
@limiter.limit("5/minute")
async def admin_login(
    request: Request,  # slowapi がレート制限キーの取得に使う
    body: AdminLoginRequest,
) -> AdminTokenResponse:
    # ID・パスワードのどちらが違うかは区別しない（管理者IDの存在を漏らさない）
    if not admin_accounts.verify_admin(body.admin_id, body.password):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="invalid id or password",
        )
    return AdminTokenResponse(access_token=auth_utils.create_admin_access_token(body.admin_id))


@router.get("/overview", response_model=AdminOverview)
async def overview(
    _admin_id: Annotated[str, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminOverview:
    user_count = (await session.exec(select(func.count(col(User.id))))).one()
    workspace_count = (await session.exec(select(func.count(col(Workspace.id))))).one()
    sensor_count = (
        await session.exec(
            select(func.count(col(Sensor.id))).where(col(Sensor.workspace_id).is_not(None))
        )
    ).one()
    reading_count = (
        await session.exec(
            select(func.count(col(Reading.id)))
            .join(Sensor, col(Sensor.id) == col(Reading.sensor_id))
            .where(col(Sensor.workspace_id).is_not(None))
        )
    ).one()
    db_size = (
        await session.execute(text("SELECT pg_database_size(current_database())"))
    ).scalar_one()
    return AdminOverview(
        user_count=user_count,
        workspace_count=workspace_count,
        sensor_count=sensor_count,
        reading_count=reading_count,
        database_size_bytes=int(db_size),
    )


@router.get("/users", response_model=list[AdminUserSummary])
async def list_users(
    _admin_id: Annotated[str, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> list[AdminUserSummary]:
    return await _load_user_summaries(session)


@router.get("/users/{user_id}", response_model=AdminUserDetail)
async def get_user(
    user_id: UUID,
    _admin_id: Annotated[str, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminUserDetail:
    summaries = await _load_user_summaries(session, user_id=user_id)
    if not summaries:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="user not found")
    summary = summaries[0]

    sensors: list[AdminSensorSummary] = []
    if summary.workspace_id is not None:
        sensor_rows = (
            await session.exec(
                select(Sensor)
                .where(col(Sensor.workspace_id) == summary.workspace_id)
                .order_by(col(Sensor.name))
            )
        ).all()
        sensor_ids = [s.id for s in sensor_rows]
        reading_by_sensor: dict[UUID, tuple[int, datetime | None]] = {}
        alarm_by_sensor: dict[UUID, int] = {}
        if sensor_ids:
            r_rows = await session.exec(
                select(
                    col(Reading.sensor_id),
                    func.count(col(Reading.id)),
                    func.max(col(Reading.recorded_at)),
                )
                .where(col(Reading.sensor_id).in_(sensor_ids))
                .group_by(col(Reading.sensor_id))
            )
            for sid, count, last_at in r_rows.all():
                reading_by_sensor[sid] = (count, last_at)
            a_rows = await session.exec(
                select(col(Alarm.sensor_id), func.count(col(Alarm.id)))
                .where(col(Alarm.sensor_id).in_(sensor_ids))
                .where(col(Alarm.status) == AlarmStatus.ACTIVE)
                .group_by(col(Alarm.sensor_id))
            )
            for sid, count in a_rows.all():
                alarm_by_sensor[sid] = count

        for s in sensor_rows:
            stat: tuple[int, datetime | None] = reading_by_sensor.get(s.id, (0, None))
            sensors.append(
                AdminSensorSummary(
                    id=s.id,
                    name=s.name,
                    unit=s.unit,
                    enabled=s.enabled,
                    reading_count=stat[0],
                    last_reading_at=stat[1],
                    active_alarm_count=alarm_by_sensor.get(s.id, 0),
                )
            )

    return AdminUserDetail(**summary.model_dump(), sensors=sensors)


@router.patch("/users/{user_id}", response_model=AdminUserDetail)
async def update_user(
    user_id: UUID,
    body: AdminUserUpdate,
    admin_id: Annotated[str, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AdminUserDetail:
    user = await _get_user_or_404(session, user_id)

    if body.email is not None and body.email != user.email:
        dup = (await session.exec(select(User).where(User.email == body.email))).first()
        if dup is not None:
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="email already exists")
        user.email = body.email

    if body.password is not None:
        user.password_hash = auth_utils.hash_password(body.password)
        # 再設定後は既存のログイン（リフレッシュトークン）を全て無効化する
        tokens = (
            await session.exec(select(RefreshToken).where(RefreshToken.user_id == user.id))
        ).all()
        for rt in tokens:
            rt.revoked = True

    if body.plan is not None:
        workspaces = (
            await session.exec(select(Workspace).where(Workspace.owner_id == user.id))
        ).all()
        for ws in workspaces:
            ws.plan = body.plan

    session.add(user)
    await session.commit()
    _logger.info("admin %s updated user %s", admin_id, user_id)
    return await get_user(user_id, admin_id, session)


@router.delete("/users/{user_id}", status_code=status.HTTP_204_NO_CONTENT)
async def delete_user(
    user_id: UUID,
    admin_id: Annotated[str, Depends(require_admin)],
    session: Annotated[AsyncSession, Depends(get_session)],
) -> Response:
    user = await _get_user_or_404(session, user_id)

    # 外部キーに ON DELETE が無い依存は、子から順に明示的に消す。
    # sensors → readings/alarms は DB 側の ON DELETE CASCADE に任せる。
    ws_ids = (
        await session.exec(select(col(Workspace.id)).where(col(Workspace.owner_id) == user.id))
    ).all()
    if ws_ids:
        dash_ids = (
            await session.exec(
                select(col(Dashboard.id)).where(col(Dashboard.workspace_id).in_(ws_ids))
            )
        ).all()
        if dash_ids:
            widget_ids = (
                await session.exec(
                    select(col(Widget.id)).where(col(Widget.dashboard_id).in_(dash_ids))
                )
            ).all()
            if widget_ids:
                await session.execute(
                    delete(WidgetConfig).where(col(WidgetConfig.widget_id).in_(widget_ids))
                )
            await session.execute(delete(Widget).where(col(Widget.dashboard_id).in_(dash_ids)))
        await session.execute(delete(Dashboard).where(col(Dashboard.workspace_id).in_(ws_ids)))
        await session.execute(delete(Sensor).where(col(Sensor.workspace_id).in_(ws_ids)))
        await session.execute(
            delete(NotificationSettings).where(col(NotificationSettings.workspace_id).in_(ws_ids))
        )
        await session.execute(
            delete(RefreshToken).where(col(RefreshToken.workspace_id).in_(ws_ids))
        )
        await session.execute(delete(Workspace).where(col(Workspace.id).in_(ws_ids)))

    await session.execute(delete(RefreshToken).where(col(RefreshToken.user_id) == user.id))
    await session.delete(user)
    await session.commit()
    _logger.warning("admin %s deleted user %s", admin_id, user_id)
    return Response(status_code=status.HTTP_204_NO_CONTENT)
