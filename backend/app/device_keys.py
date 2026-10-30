"""機器ごとのキー（取り込みの認証・自前ホスト用）。

キーは発行の時に 1 回だけ表示し、DB には SHA-256 のハッシュだけを保存する。
キーは十分な長さの乱数（32 バイト）なので、ハッシュの一致で検索しても推測されない。

使い方は app/device_cli.py を参照。
"""
import hashlib
import secrets
from datetime import UTC, datetime

from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app.db.models import IngestDevice, Sensor


def hash_device_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


async def create_device(session: AsyncSession, name: str) -> str:
    """機器を作り、キーを返す（この 1 回だけ、キーが画面に出る）。"""
    key = secrets.token_urlsafe(32)
    session.add(IngestDevice(name=name, key_hash=hash_device_key(key)))
    await session.commit()
    return key


async def find_active_device(session: AsyncSession, key: str) -> IngestDevice | None:
    """キーに対応する、失効していない機器を返す。無い・失効しているなら None。"""
    result = await session.exec(
        select(IngestDevice).where(
            IngestDevice.key_hash == hash_device_key(key),
            col(IngestDevice.revoked_at).is_(None),
        )
    )
    return result.first()


async def get_device_by_name(session: AsyncSession, name: str) -> IngestDevice | None:
    result = await session.exec(select(IngestDevice).where(IngestDevice.name == name))
    return result.first()


async def attach_sensors(
    session: AsyncSession, device: IngestDevice, ingest_keys: list[str]
) -> list[str]:
    """センサーを、機器に所属させる。見つからなかった ingestKey を返す。"""
    missing: list[str] = []
    for ingest_key in ingest_keys:
        result = await session.exec(select(Sensor).where(Sensor.ingest_key == ingest_key))
        sensor = result.first()
        if sensor is None:
            missing.append(ingest_key)
            continue
        sensor.device_id = device.id
        session.add(sensor)
    await session.commit()
    return missing


async def revoke_device(session: AsyncSession, device: IngestDevice) -> None:
    """機器のキーを失効させる（キーは使えなくなる。センサーの所属は残る）。"""
    device.revoked_at = datetime.now(UTC)
    session.add(device)
    await session.commit()
