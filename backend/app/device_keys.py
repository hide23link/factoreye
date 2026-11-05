"""機器ごとのキー（取り込みの認証・自前ホスト用）。

キーは発行の時に 1 回だけ表示し、DB には SHA-256 のハッシュだけを保存する。
キーは十分な長さの乱数（32 バイト）なので、ハッシュの一致で検索しても推測されない。

使い方は app/device_cli.py を参照。
"""
import hashlib
import secrets
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import update
from sqlmodel import col, select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import ingest_cache
from app.db.models import KEY_HINT_LENGTH, IngestDevice, Sensor


def hash_device_key(key: str) -> str:
    return hashlib.sha256(key.encode()).hexdigest()


# 系統の名前の最大の長さ（文字数）。IngestDevice.line の列の長さと同じ
MAX_LINE_LENGTH = 40


def normalize_line(line: str | None) -> str | None:
    """系統の名前を整える。前後の空白を除き、空なら None（系統なし）。長すぎれば ValueError。"""
    cleaned = (line or "").strip()
    if len(cleaned) > MAX_LINE_LENGTH:
        raise ValueError(f"系統は {MAX_LINE_LENGTH} 文字までです")
    return cleaned or None


async def create_device(session: AsyncSession, name: str, line: str | None = None) -> str:
    """機器を作り、キーを返す（この 1 回だけ、キーが画面に出る）。line は任意の系統。"""
    key = secrets.token_urlsafe(32)
    session.add(
        IngestDevice(
            name=name,
            key_hash=hash_device_key(key),
            key_hint=key[:KEY_HINT_LENGTH],
            line=normalize_line(line),
        )
    )
    await session.commit()
    ingest_cache.clear()
    return key


async def set_device_line(
    session: AsyncSession, device: IngestDevice, line: str | None
) -> str | None:
    """機器の系統を付ける・変える（None か空で外す）。保存した系統（外したら None）を返す。

    センサー一覧の版（ETag）は updated_at から作るので、所属するセンサーの updated_at も進める
    （進めないと、画面が古い系統のまま 304 を受け取る）。
    """
    await session.refresh(device)  # 前の commit で期限切れになっていても読めるようにする
    saved = normalize_line(line)  # 長すぎれば、ここで ValueError（何も変えない）
    device.line = saved
    session.add(device)
    await session.exec(
        update(Sensor)
        .where(col(Sensor.device_id) == device.id)
        .values(updated_at=datetime.now(UTC))
    )
    await session.commit()
    return saved


async def find_active_device(session: AsyncSession, key: str) -> IngestDevice | None:
    """キーに対応する、失効していない機器を返す。無い・失効しているなら None。"""
    result = await session.exec(
        select(IngestDevice).where(
            IngestDevice.key_hash == hash_device_key(key),
            col(IngestDevice.revoked_at).is_(None),
        )
    )
    return result.first()


async def find_active_device_id(session: AsyncSession, key: str) -> UUID | None:
    """キーに対応する、失効していない機器の id。数秒のキャッシュを使う（app/ingest_cache.py）。

    見つからない・失効している場合は None（その結果は覚えない）。
    """
    key_hash = hash_device_key(key)
    cached = ingest_cache.get_device(key_hash)
    if cached is not None:
        return cached
    result = await session.exec(
        select(IngestDevice.id).where(
            IngestDevice.key_hash == key_hash,
            col(IngestDevice.revoked_at).is_(None),
        )
    )
    device_id = result.first()
    if device_id is not None:
        ingest_cache.put_device(key_hash, device_id)
    return device_id


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
        # 一覧の版（ETag）は updated_at から作る。進めないと、画面が機器の表示を更新しない
        sensor.updated_at = datetime.now(UTC)
        session.add(sensor)
    await session.commit()
    ingest_cache.clear()
    return missing


async def revoke_device(session: AsyncSession, device: IngestDevice) -> None:
    """機器のキーを失効させる（キーは使えなくなる。センサーの所属は残る）。"""
    device.revoked_at = datetime.now(UTC)
    session.add(device)
    await session.commit()
    ingest_cache.clear()


class DeviceNotRevokedError(Exception):
    """失効していない機器は、削除できない（先に失効する）。"""


async def delete_device(session: AsyncSession, device: IngestDevice) -> None:
    """失効済みの機器を削除する。所属していたセンサーと測定値は残り、センサーは「機器なし」に戻る。

    センサーの所属は DB の外部キー（ON DELETE SET NULL）で外れる。センサー一覧の版（ETag）は
    updated_at から作るので、所属していたセンサーの updated_at を進める
    （進めないと、画面が古い所属のまま 304 を受け取る）。
    """
    if device.revoked_at is None:
        raise DeviceNotRevokedError
    await session.exec(
        update(Sensor)
        .where(col(Sensor.device_id) == device.id)
        .values(updated_at=datetime.now(UTC))
    )
    await session.delete(device)
    await session.commit()
    ingest_cache.clear()
