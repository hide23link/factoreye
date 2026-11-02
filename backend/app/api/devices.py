"""機器の管理API。Web の設定画面「機器」から使う（OSS 版＝self-hosted だけ。SaaS では 404）。

機器ごとのキー（X-Device-Key）の発行・センサーの所属・キーの失効を、コマンド（app/device_cli.py）と
同じ処理（app/device_keys.py）で行う。

- GET  /api/devices                     機器の一覧（所属センサー・最後の受信つき。キーは返さない）
- POST /api/devices                     機器を作る。キーは、この応答で 1 回だけ返す
- POST /api/devices/{id}/sensors        センサーを機器に所属させる（本文: ingestKeys）。
                                       別の機器に所属中のセンサーは 409（付け替えはコマンドで）
- POST /api/devices/{id}/revoke         機器のキーを失効させる

他の書き込みAPIと同じく、この API 自体に認証はない（ネットワーク境界で守る前提。OSS の方針）。
キーは作成時に 1 回だけ返し、DB にはハッシュしか残らないので、あとから読み出す API は無い。

【引数】session は FastAPI が Depends で自動で渡す。
"""
from datetime import datetime
from typing import Annotated
from uuid import UUID

from fastapi import APIRouter, Depends, HTTPException, status
from pydantic import Field
from sqlalchemy import func
from sqlalchemy.exc import IntegrityError
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_keys
from app.config import AuthMode, settings
from app.db.models import IngestDevice, Reading, Sensor
from app.db.session import get_session
from app.schemas import CamelModel


def _self_hosted_only() -> None:
    """SaaS（multi_tenant）には機器の管理は無い。存在しないものとして 404 にする。"""
    if settings.auth_mode == AuthMode.MULTI_TENANT:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND)


router = APIRouter(
    prefix="/api/devices", tags=["devices"], dependencies=[Depends(_self_hosted_only)]
)


class DeviceRead(CamelModel):
    id: UUID
    name: str
    line: str | None
    created_at: datetime
    revoked_at: datetime | None
    # 所属するセンサーの最新の測定値の時刻（まだ受信がなければ None）
    last_received_at: datetime | None
    sensors: list[str]  # 所属するセンサーの ingestKey


class DeviceCreated(DeviceRead):
    key: str  # 発行したキー。この応答でしか読めない


class DeviceCreate(CamelModel):
    name: str = Field(min_length=1, max_length=100)
    line: str | None = None


class AttachRequest(CamelModel):
    ingest_keys: list[str] = Field(min_length=1, max_length=200)


class AttachResult(CamelModel):
    missing: list[str]  # 見つからなかった ingestKey（残りは所属させた）


async def _read_device(session: AsyncSession, device_id: UUID) -> DeviceRead:
    """機器 1 件を応答の形にする（一覧は _list_devices でまとめて取る）。

    commit のあとはモデルの属性が期限切れになるので、呼ぶ側は id だけを先に控えて渡す。
    """
    return (await _list_devices(session, only=device_id))[0]


async def _list_devices(session: AsyncSession, only: UUID | None = None) -> list[DeviceRead]:
    query = select(IngestDevice).order_by(col(IngestDevice.created_at), col(IngestDevice.name))
    if only is not None:
        query = query.where(IngestDevice.id == only)
    devices = list((await session.exec(query)).all())

    sensor_query = select(Sensor.device_id, Sensor.ingest_key, Sensor.id).where(
        col(Sensor.device_id).is_not(None)
    )
    if only is not None:
        sensor_query = sensor_query.where(Sensor.device_id == only)
    sensors_by_device: dict[UUID, list[tuple[str, UUID]]] = {}
    for device_id, ingest_key, sensor_id in (await session.exec(sensor_query)).all():
        if device_id is None:
            continue
        sensors_by_device.setdefault(device_id, []).append((ingest_key, sensor_id))

    # 最後の受信: センサーごとに、主キーの索引で最新の 1 行を引く（全測定値は走査しない）
    last_by_sensor: dict[UUID, datetime] = {}
    sensor_ids = [sid for pairs in sensors_by_device.values() for _, sid in pairs]
    if sensor_ids:
        latest = (
            select(func.max(Reading.recorded_at))
            .where(Reading.sensor_id == Sensor.id)
            .scalar_subquery()
        )
        rows = await session.exec(select(Sensor.id, latest).where(col(Sensor.id).in_(sensor_ids)))
        last_by_sensor = {sid: ts for sid, ts in rows.all() if ts is not None}

    result: list[DeviceRead] = []
    for device in devices:
        pairs = sorted(sensors_by_device.get(device.id, []))
        times = [last_by_sensor[sid] for _, sid in pairs if sid in last_by_sensor]
        result.append(
            DeviceRead(
                id=device.id,
                name=device.name,
                line=device.line,
                created_at=device.created_at,
                revoked_at=device.revoked_at,
                last_received_at=max(times) if times else None,
                sensors=[key for key, _ in pairs],
            )
        )
    return result


async def _get_or_404(session: AsyncSession, device_id: UUID) -> IngestDevice:
    device = await session.get(IngestDevice, device_id)
    if device is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="device not found")
    return device


@router.get("", response_model=list[DeviceRead])
async def list_devices(session: Annotated[AsyncSession, Depends(get_session)]) -> list[DeviceRead]:
    return await _list_devices(session)


@router.post("", response_model=DeviceCreated, status_code=status.HTTP_201_CREATED)
async def create_device(
    body: DeviceCreate, session: Annotated[AsyncSession, Depends(get_session)]
) -> DeviceCreated:
    name = body.name.strip()
    if not name:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="name is empty"
        )
    try:
        device_keys.normalize_line(body.line)  # 長すぎれば、作る前に断る
    except ValueError as error:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail=str(error)
        ) from error
    if await device_keys.get_device_by_name(session, name) is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="device name already exists"
        )
    try:
        key = await device_keys.create_device(session, name, body.line)
    except IntegrityError as error:  # 同時に同じ名前が作られた
        await session.rollback()
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="device name already exists"
        ) from error
    device = await device_keys.get_device_by_name(session, name)
    assert device is not None
    return DeviceCreated(**(await _read_device(session, device.id)).model_dump(), key=key)


@router.post("/{device_id}/sensors", response_model=AttachResult)
async def attach_sensors(
    device_id: UUID,
    body: AttachRequest,
    session: Annotated[AsyncSession, Depends(get_session)],
) -> AttachResult:
    device = await _get_or_404(session, device_id)
    if device.revoked_at is not None:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="device is revoked")
    # 別の機器に所属中のセンサーは付け替えない（付け替えると、その機器のキーで送れなくなる）。
    # 付け替えたいときは、コマンド（device_cli attach）で行う
    owned = await session.exec(
        select(Sensor.ingest_key).where(
            col(Sensor.ingest_key).in_(body.ingest_keys),
            col(Sensor.device_id).is_not(None),
            Sensor.device_id != device.id,
        )
    )
    taken = sorted(owned.all())
    if taken:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=f"already attached to another device: {', '.join(taken)}",
        )
    missing = await device_keys.attach_sensors(session, device, body.ingest_keys)
    return AttachResult(missing=missing)


@router.post("/{device_id}/revoke", response_model=DeviceRead)
async def revoke_device(
    device_id: UUID, session: Annotated[AsyncSession, Depends(get_session)]
) -> DeviceRead:
    device = await _get_or_404(session, device_id)
    if device.revoked_at is None:
        await device_keys.revoke_device(session, device)
    return await _read_device(session, device_id)
