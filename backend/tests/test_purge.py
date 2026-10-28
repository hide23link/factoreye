"""14日データ削除バッチ + Free Tier センサー上限のテスト。"""
from datetime import UTC, datetime, timedelta
from uuid import UUID, uuid4

from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import purge as purge_module
from app.db.models import Reading, RefreshToken, Sensor, User, Workspace
from app.db.session import engine
from app.purge import purge_expired_refresh_tokens, purge_old_readings


async def _create_sensor(session: AsyncSession, workspace_id: UUID | None = None) -> Sensor:
    sensor = Sensor(
        workspace_id=workspace_id,
        name=f"sensor-{uuid4().hex[:8]}",
        ingest_key=uuid4().hex,
        unit="count",
    )
    session.add(sensor)
    await session.flush()
    return sensor


async def _create_reading(session: AsyncSession, sensor_id: UUID, recorded_at: datetime) -> Reading:
    r = Reading(sensor_id=sensor_id, value=1.0, recorded_at=recorded_at)
    session.add(r)
    return r


# ── 14日削除バッチ ────────────────────────────────────────────

async def test_purge_deletes_old_multi_tenant_readings() -> None:
    """multi-tenant の 14日超えデータを削除する。"""
    from app.auth import hash_password
    async with AsyncSession(engine) as session:
        user = User(email=f"purge-{uuid4().hex[:6]}@example.com", password_hash=hash_password("pw"))
        session.add(user)
        await session.flush()
        ws = Workspace(name="purge-ws", owner_id=user.id)
        session.add(ws)
        await session.flush()

        sensor = await _create_sensor(session, workspace_id=ws.id)
        old = datetime.now(UTC) - timedelta(days=15)
        recent = datetime.now(UTC) - timedelta(days=10)

        sensor_id = sensor.id  # commit で expire される前に取得
        await _create_reading(session, sensor_id, old)
        await _create_reading(session, sensor_id, recent)
        await session.commit()

    deleted = await purge_old_readings()
    assert deleted == 1

    async with AsyncSession(engine) as session:
        result = await session.exec(select(Reading).where(Reading.sensor_id == sensor_id))
        remaining = result.all()
    assert len(remaining) == 1
    assert remaining[0].recorded_at.replace(tzinfo=UTC) > datetime.now(UTC) - timedelta(days=14)


async def test_purge_skips_self_hosted_readings() -> None:
    """self-hosted（workspace_id=None）のデータは削除しない。"""
    async with AsyncSession(engine) as session:
        sensor = await _create_sensor(session, workspace_id=None)
        sensor_id = sensor.id  # commit で expire される前に取得
        old = datetime.now(UTC) - timedelta(days=100)
        await _create_reading(session, sensor_id, old)
        await session.commit()

    deleted = await purge_old_readings()
    assert deleted == 0

    async with AsyncSession(engine) as session:
        result = await session.exec(select(Reading).where(Reading.sensor_id == sensor_id))
        assert len(result.all()) == 1


async def test_purge_returns_zero_when_nothing_to_delete() -> None:
    """削除対象がなければ 0 を返す。"""
    deleted = await purge_old_readings()
    assert deleted == 0


# ── 期限切れリフレッシュトークンの削除 ─────────────────────────

async def _create_user_ws(session: AsyncSession) -> tuple[UUID, UUID]:
    from app.auth import hash_password
    user = User(email=f"rt-{uuid4().hex[:8]}@example.com", password_hash=hash_password("pw"))
    session.add(user)
    await session.flush()
    ws = Workspace(name="rt-ws", owner_id=user.id)
    session.add(ws)
    await session.flush()
    return user.id, ws.id


def _token(user_id: UUID, ws_id: UUID, days_from_now: float, revoked: bool = False) -> RefreshToken:
    return RefreshToken(
        user_id=user_id,
        workspace_id=ws_id,
        token_hash=uuid4().hex + uuid4().hex,
        expires_at=datetime.now(UTC) + timedelta(days=days_from_now),
        revoked=revoked,
    )


async def _remaining_hashes() -> set[str]:
    async with AsyncSession(engine) as session:
        return {t.token_hash for t in (await session.exec(select(RefreshToken))).all()}


async def test_purge_refresh_tokens_deletes_only_expired() -> None:
    """期限切れ（猶予後）だけ消え、有効・期限内の失効済み・猶予内の行は残る。"""
    async with AsyncSession(engine) as session:
        u1, w1 = await _create_user_ws(session)
        u2, w2 = await _create_user_ws(session)
        expired = _token(u1, w1, -30)
        expired_revoked = _token(u1, w1, -30, revoked=True)
        expired_other_user = _token(u2, w2, -60)
        valid = _token(u1, w1, 10)
        valid_other_user = _token(u2, w2, 10)
        revoked_in_term = _token(u1, w1, 10, revoked=True)  # ローテーション・ログアウト後
        in_grace = _token(u2, w2, -1)  # 期限切れだが猶予内
        session.add_all([expired, expired_revoked, expired_other_user, valid,
                         valid_other_user, revoked_in_term, in_grace])
        keep = {valid.token_hash, valid_other_user.token_hash,
                revoked_in_term.token_hash, in_grace.token_hash}  # commit で expire する前に取得
        await session.commit()

    assert await purge_expired_refresh_tokens() == 3
    assert await _remaining_hashes() == keep


async def test_purge_refresh_tokens_keeps_other_users_token_usable(client) -> None:  # type: ignore[no-untyped-def]
    """あるユーザーの期限切れの削除が、別ユーザーの有効なトークンの更新に影響しない。"""
    from fastapi import FastAPI
    from httpx import ASGITransport, AsyncClient

    from app.api import auth as auth_module
    from app.config import AuthMode, settings

    original_mode = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    try:
        test_app = FastAPI()
        test_app.include_router(auth_module.router)
        async with AsyncClient(transport=ASGITransport(app=test_app), base_url="http://test") as c:
            reg = await c.post("/api/auth/register", json={
                "email": f"rt-{uuid4().hex[:6]}@example.com",
                "password": "password123",
                "workspaceName": "RtWS",
            })
            assert reg.status_code == 201
            refresh_token = reg.json()["refreshToken"]

            async with AsyncSession(engine) as session:
                u, w = await _create_user_ws(session)
                session.add(_token(u, w, -40))
                await session.commit()

            assert await purge_expired_refresh_tokens() == 1
            resp = await c.post("/api/auth/refresh", json={"refreshToken": refresh_token})
            assert resp.status_code == 200
    finally:
        settings.auth_mode = original_mode


async def test_purge_refresh_tokens_is_idempotent() -> None:
    """2 回実行しても安全で、2 回目は 0 件。"""
    async with AsyncSession(engine) as session:
        u, w = await _create_user_ws(session)
        session.add_all([_token(u, w, -30), _token(u, w, 5)])
        await session.commit()

    assert await purge_expired_refresh_tokens() == 1
    assert await purge_expired_refresh_tokens() == 0
    assert len(await _remaining_hashes()) == 1


async def test_purge_refresh_tokens_empty_table() -> None:
    """self-hosted のようにテーブルが空でも 0 件で動く。"""
    assert await purge_expired_refresh_tokens() == 0


async def test_purge_refresh_tokens_batches(monkeypatch) -> None:  # type: ignore[no-untyped-def]
    """バッチより多い件数でも、すべて消える（バッチ境界ちょうどを含む）。"""
    monkeypatch.setattr(purge_module, "_PURGE_BATCH_SIZE", 10)
    async with AsyncSession(engine) as session:
        u, w = await _create_user_ws(session)
        session.add_all([_token(u, w, -30) for _ in range(30)])
        session.add_all([_token(u, w, 5) for _ in range(3)])
        await session.commit()

    assert await purge_expired_refresh_tokens() == 30
    assert len(await _remaining_hashes()) == 3


# ── Free Tier センサー上限（HTTP API） ────────────────────────

async def test_sensor_limit_enforced(client) -> None:  # type: ignore[no-untyped-def]
    """multi-tenant で 10個超えは 402 を返す。"""
    import httpx
    from fastapi import FastAPI
    from httpx import ASGITransport

    from app.api import auth as auth_module
    from app.config import AuthMode, settings

    original_mode = settings.auth_mode
    settings.auth_mode = AuthMode.MULTI_TENANT
    try:
        # 登録してトークン取得
        test_app = FastAPI()
        test_app.include_router(auth_module.router)
        from app.api import sensors as sensors_module
        test_app.include_router(sensors_module.router)

        async with httpx.AsyncClient(
            transport=ASGITransport(app=test_app), base_url="http://test"
        ) as c:
            reg = await c.post("/api/auth/register", json={
                "email": f"limit-{uuid4().hex[:6]}@example.com",
                "password": "password123",
                "workspaceName": "LimitWS",
            })
            assert reg.status_code == 201
            token = reg.json()["accessToken"]
            headers = {"Authorization": f"Bearer {token}"}

            # 10個まで作成
            for i in range(10):
                resp = await c.post("/api/sensors", json={
                    "name": f"sensor-limit-{i}",
                    "ingestKey": f"key-limit-{i}",
                    "unit": "count",
                }, headers=headers)
                assert resp.status_code == 201, f"sensor {i}: {resp.json()}"

            # 11個目は 402
            resp = await c.post("/api/sensors", json={
                "name": "sensor-over-limit",
                "ingestKey": "key-over-limit",
                "unit": "count",
            }, headers=headers)
            assert resp.status_code == 402
    finally:
        settings.auth_mode = original_mode
