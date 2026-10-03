"""ランナーの動作テスト。HTTP はモック（httpx.MockTransport）に置き換え、実サーバーには接続しない。"""
import asyncio
import json
import uuid

import httpx
import pytest

from emulator.runner import Runner
from emulator.scenario import Scenario

TARGET = "http://loadtest.invalid"


class FakeServer:
    """最小限の FactorEye 互換応答を返す。受け取った取り込み件数を数える。"""

    def __init__(self) -> None:
        self.ingest_count = 0
        self.sensor_creates = 0
        self.registers = 0

    def handler(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path
        if path == "/api/auth/register":
            self.registers += 1
            return httpx.Response(201, json={"accessToken": "tok", "refreshToken": "r"})
        if path == "/api/auth/login":
            return httpx.Response(200, json={"accessToken": "tok", "refreshToken": "r"})
        if path == "/api/sensors" and request.method == "POST":
            self.sensor_creates += 1
            return httpx.Response(201, json={"id": str(uuid.uuid4())})
        if path == "/api/ingest/readings":
            body = json.loads(request.content)
            assert body["ingestKey"], "取り込みには ingestKey が必要"
            self.ingest_count += 1
            return httpx.Response(202, json={"accepted": 1})
        if path == "/api/dashboards" and request.method == "POST":
            return httpx.Response(201, json={})
        return httpx.Response(200, json=[])


def _scenario(**overrides: object) -> Scenario:
    base = Scenario(
        target_url=TARGET,
        users=3,
        sensors_per_user=2,
        send_interval_s=0.2,
        jitter_s=0.0,
        viewers_per_user=1,
        viewer_interval_s=0.2,
    )
    return base.with_patch(dict(overrides)) if overrides else base


def _run(coro):  # type: ignore[no-untyped-def]
    return asyncio.run(coro)


def test_start_sends_readings_and_creates_sensors() -> None:
    async def scenario_run() -> dict[str, object]:
        server = FakeServer()
        runner = Runner(transport=httpx.MockTransport(server.handler))
        await runner.start(_scenario())
        await asyncio.sleep(1.0)
        status = runner.status()
        await runner.stop()
        assert server.registers == 3
        assert server.sensor_creates == 6
        assert server.ingest_count > 0
        return status

    status = _run(scenario_run())
    assert status["state"] == "running"
    users = status["users"]
    assert users["running"] == 3  # type: ignore[index]
    assert users["sensors"] == 6  # type: ignore[index]
    assert status["metrics"]["errors"] == 0  # type: ignore[index]


def test_live_scale_down_and_up_changes_user_count() -> None:
    async def scenario_run() -> tuple[int, int, int]:
        runner = Runner(transport=httpx.MockTransport(FakeServer().handler))
        await runner.start(_scenario())
        await asyncio.sleep(0.6)
        mode = await runner.apply(_scenario(users=1))
        assert mode == "live"
        down = len(runner._users)
        mode = await runner.apply(_scenario(users=4))
        await asyncio.sleep(0.6)
        up = len(runner._users)
        await runner.stop()
        return down, up, runner.scenario.users

    down, up, users = _run(scenario_run())
    assert down == 1
    assert up == 4
    assert users == 4


def test_live_sensor_count_change_applies_to_running_users() -> None:
    async def scenario_run() -> int:
        runner = Runner(transport=httpx.MockTransport(FakeServer().handler))
        await runner.start(_scenario(users=2, sensors_per_user=1))
        await asyncio.sleep(0.6)
        await runner.apply(_scenario(users=2, sensors_per_user=3))
        await asyncio.sleep(0.8)
        total = sum(len(vu.sensors) for vu in runner._users.values())
        await runner.stop()
        return total

    assert _run(scenario_run()) == 6


def test_stop_cancels_all_tasks() -> None:
    async def scenario_run() -> tuple[str, int]:
        runner = Runner(transport=httpx.MockTransport(FakeServer().handler))
        await runner.start(_scenario())
        await asyncio.sleep(0.4)
        await runner.stop()
        return runner.state, len(runner._user_tasks)

    state, remaining = _run(scenario_run())
    assert state == "stopped"
    assert remaining == 0


def test_production_target_cannot_be_started() -> None:
    async def scenario_run() -> None:
        runner = Runner(transport=httpx.MockTransport(FakeServer().handler))
        with pytest.raises(ValueError):
            await runner.start(Scenario(target_url="https://factoreye.hide23.link"))

    _run(scenario_run())


def test_apply_while_idle_only_saves() -> None:
    async def scenario_run() -> str:
        runner = Runner(transport=httpx.MockTransport(FakeServer().handler))
        return await runner.apply(_scenario(users=7))

    assert _run(scenario_run()) == "saved"


def test_cleanup_deletes_only_load_test_users() -> None:
    deleted_ids: list[str] = []

    def handler(request: httpx.Request) -> httpx.Response:
        if request.url.path == "/api/admin/login":
            return httpx.Response(200, json={"accessToken": "admin-tok", "tokenType": "bearer"})
        if request.url.path == "/api/admin/users" and request.method == "GET":
            return httpx.Response(
                200,
                json=[
                    {"id": "u-lt", "email": "lt-1a2b3c4d-001@example.com"},
                    {"id": "u-other", "email": "tanaka@example.com"},
                    {"id": "u-lookalike", "email": "lt-xyz@example.com"},
                ],
            )
        if request.url.path.startswith("/api/admin/users/") and request.method == "DELETE":
            deleted_ids.append(request.url.path.rsplit("/", 1)[-1])
            return httpx.Response(204)
        return httpx.Response(404)

    async def scenario_run() -> int:
        runner = Runner(transport=httpx.MockTransport(handler))
        return await runner.cleanup_remote(TARGET, "qa-admin", "pw")

    assert _run(scenario_run()) == 1
    assert deleted_ids == ["u-lt"]


def test_cleanup_rejects_bad_admin_login() -> None:
    def handler(request: httpx.Request) -> httpx.Response:
        return httpx.Response(401, json={"detail": "invalid id or password"})

    async def scenario_run() -> None:
        runner = Runner(transport=httpx.MockTransport(handler))
        with pytest.raises(PermissionError):
            await runner.cleanup_remote(TARGET, "x", "y")

    _run(scenario_run())
