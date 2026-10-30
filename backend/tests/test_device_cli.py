"""機器のキーの CLI（app.device_cli）のテスト。

コマンドは run_command（async）で実行する。DB に触れるので、テストの DB を使う。
"""

import argparse

import httpx
import pytest
from sqlmodel import select
from sqlmodel.ext.asyncio.session import AsyncSession

from app import device_cli, device_keys
from app.config import AuthMode, settings
from app.db.models import Sensor
from app.db.session import engine


def _cli(*argv: str) -> argparse.Namespace:
    return device_cli.parse_args(list(argv))


async def test_create_prints_a_key_once_and_rejects_duplicates(
    capsys: pytest.CaptureFixture[str],
) -> None:
    assert await device_cli.run_command(_cli("create", "cli-a")) == 0
    out = capsys.readouterr().out
    key_lines = [line for line in out.splitlines() if line and not line.startswith("機器")]
    assert len(key_lines) == 1 and len(key_lines[0]) >= 40  # 32 バイトの乱数（base64url）
    assert await device_cli.run_command(_cli("create", "cli-a")) == 1
    assert "同じ名前" in capsys.readouterr().err


async def test_attach_partial_returns_1_and_keeps_found_sensors(
    client: httpx.AsyncClient, capsys: pytest.CaptureFixture[str]
) -> None:
    resp = await client.post(
        "/api/sensors", json={"name": "cli-s1", "ingestKey": "cli-s1", "unit": "V"}
    )
    assert resp.status_code == 201
    await device_cli.run_command(_cli("create", "cli-b"))
    code = await device_cli.run_command(_cli("attach", "cli-b", "cli-s1", "cli-missing"))
    assert code == 1
    assert "cli-missing" in capsys.readouterr().err
    async with AsyncSession(engine) as session:
        sensor = (await session.exec(select(Sensor).where(Sensor.ingest_key == "cli-s1"))).one()
        device = await device_keys.get_device_by_name(session, "cli-b")
        assert device is not None
        assert sensor.device_id == device.id


async def test_attach_to_missing_device_returns_1(capsys: pytest.CaptureFixture[str]) -> None:
    assert await device_cli.run_command(_cli("attach", "cli-nope", "x")) == 1
    assert "機器が見つかりません" in capsys.readouterr().err


async def test_revoke_makes_the_key_fail(client: httpx.AsyncClient) -> None:
    await client.post("/api/sensors", json={"name": "cli-r", "ingestKey": "cli-r", "unit": "V"})
    async with AsyncSession(engine) as session:
        key = await device_keys.create_device(session, "cli-c")
    await device_cli.run_command(_cli("attach", "cli-c", "cli-r"))
    assert await device_cli.run_command(_cli("revoke", "cli-c")) == 0
    resp = await client.post(
        "/api/ingest/readings",
        headers={"X-Device-Key": key},
        json={"ingestKey": "cli-r", "value": 1},
    )
    assert resp.status_code == 401


async def test_list_shows_state_and_count(capsys: pytest.CaptureFixture[str]) -> None:
    await device_cli.run_command(_cli("create", "cli-d"))
    await device_cli.run_command(_cli("revoke", "cli-d"))
    assert await device_cli.run_command(_cli("list")) == 0
    out = capsys.readouterr().out
    assert "cli-d\t失効\tセンサー 0" in out


def test_cli_refuses_in_saas_mode(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(settings, "auth_mode", AuthMode.MULTI_TENANT)
    assert device_cli.main(["list"]) == 1
    assert "自前ホスト" in capsys.readouterr().err
