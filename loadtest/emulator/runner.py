"""負荷テストの実行管理。仮想ユーザーの起動・停止、実行中のシナリオ変更、後片付けを担う。

実行中の変更の反映:
- 閲覧者数・センサー数・送信間隔・値の傾向など: 次のループ判定から反映（再起動なし）
- 仮想ユーザー数: 増えた分は新規に登録して起動、減った分は停止
- 対象URL: 変更は再起動が必要なので、停止して新しい設定で起動し直す
"""
import asyncio
import re
import uuid
from datetime import UTC, datetime

import httpx

from emulator.api_client import ApiClient
from emulator.metrics import Metrics
from emulator.scenario import Scenario
from emulator.vuser import VirtualUser

# 同時に行う登録・セットアップの数（起動直後の負荷を分散させる）
_SETUP_CONCURRENCY = 10


class Runner:
    def __init__(self, transport: httpx.AsyncBaseTransport | None = None) -> None:
        self._scenario = Scenario()
        self._transport = transport
        self.metrics = Metrics()
        self.state = "idle"  # idle / running / stopped
        self.run_id = ""
        self.started_at: datetime | None = None
        self._client: ApiClient | None = None
        self._users: dict[int, VirtualUser] = {}
        self._user_tasks: dict[int, asyncio.Task[None]] = {}
        self._setup_sem: asyncio.Semaphore | None = None

    @property
    def scenario(self) -> Scenario:
        return self._scenario

    # ── 開始・停止 ───────────────────────────────────────

    async def start(self, scenario: Scenario) -> None:
        if self.state == "running":
            raise RuntimeError("すでに実行中です")
        scenario.validate()
        self._scenario = scenario
        self.metrics.reset()
        self.run_id = uuid.uuid4().hex[:8]
        self.started_at = datetime.now(UTC)
        self._client = ApiClient(scenario.target_url, self.metrics, self._transport)
        self._setup_sem = asyncio.Semaphore(_SETUP_CONCURRENCY)
        self.state = "running"
        for i in range(scenario.users):
            self._spawn_user(i)

    async def stop(self) -> None:
        if self.state != "running":
            return
        self.state = "stopped"
        tasks = list(self._user_tasks.values())
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        await asyncio.gather(*(vu.stop() for vu in self._users.values()), return_exceptions=True)
        self._users.clear()
        self._user_tasks.clear()
        if self._client is not None:
            await self._client.close()
            self._client = None

    async def apply(self, new: Scenario) -> str:
        """シナリオを差し替える。戻り値は反映方法（saved / live / restarted）。"""
        new.validate()
        if self.state != "running":
            self._scenario = new
            return "saved"

        if new.target_url != self._scenario.target_url:
            await self.stop()
            await self.start(new)
            return "restarted"

        self._scenario = new
        current = len(self._users)
        if new.users > current:
            for i in range(current, new.users):
                self._spawn_user(i)
        elif new.users < current:
            for i in range(new.users, current):
                await self._drop_user(i)

        for vu in list(self._users.values()):
            if vu.started:
                asyncio.create_task(self._refresh_user(vu))
        return "live"

    # ── 仮想ユーザーの管理 ───────────────────────────────

    def _spawn_user(self, index: int) -> None:
        assert self._client is not None
        seed = int(self.run_id, 16) + index
        vu = VirtualUser(index, self.run_id, self, self._client, seed=seed)
        self._users[index] = vu
        self._user_tasks[index] = asyncio.create_task(self._bring_up(vu))

    async def _bring_up(self, vu: VirtualUser) -> None:
        assert self._setup_sem is not None
        async with self._setup_sem:
            ok = await vu.setup()
            if ok:
                await vu.ensure_sensors()
        # 途中で停止・縮小された場合は起動しない
        if self.state == "running" and self._users.get(vu.index) is vu and ok:
            vu.start()

    async def _refresh_user(self, vu: VirtualUser) -> None:
        await vu.ensure_sensors()
        vu.reconcile()

    async def _drop_user(self, index: int) -> None:
        task = self._user_tasks.pop(index, None)
        if task is not None:
            task.cancel()
            await asyncio.gather(task, return_exceptions=True)
        vu = self._users.pop(index, None)
        if vu is not None:
            await vu.stop()

    # ── 状態 ─────────────────────────────────────────────

    def status(self) -> dict[str, object]:
        started = [vu for vu in self._users.values() if vu.started]
        return {
            "state": self.state,
            "runId": self.run_id,
            "startedAt": self.started_at.isoformat() if self.started_at else None,
            "scenario": self._scenario.to_dict(),
            "users": {
                "target": self._scenario.users if self.state == "running" else 0,
                "running": len(started),
                "settingUp": len(self._users) - len(started),
                "sensors": sum(len(vu.sensors) for vu in started),
            },
            "metrics": self.metrics.snapshot(),
        }

    # ── 後片付け ─────────────────────────────────────────

    async def cleanup_remote(self, target_url: str, admin_id: str, admin_password: str) -> int:
        """負荷テストで作ったユーザーを、管理者APIで削除する。削除件数を返す。

        対象は「<prefix>-<実行ID8桁>-<3桁>@example.com」の形式に一致するものだけ。
        """
        prefix = re.escape(self._scenario.email_prefix)
        pattern = re.compile(rf"^{prefix}-[0-9a-f]{{8}}-\d{{3}}@example\.com$")
        async with httpx.AsyncClient(
            base_url=target_url, timeout=15.0, transport=self._transport
        ) as http:
            login = await http.post(
                "/api/admin/login", json={"adminId": admin_id, "password": admin_password}
            )
            if login.status_code != 200:
                raise PermissionError("管理者のログインに失敗しました")
            headers = {"Authorization": f"Bearer {login.json()['accessToken']}"}
            users = (await http.get("/api/admin/users", headers=headers)).json()
            targets = [u for u in users if pattern.match(u["email"])]
            deleted = 0
            for u in targets:
                resp = await http.delete(f"/api/admin/users/{u['id']}", headers=headers)
                if resp.status_code == 204:
                    deleted += 1
            return deleted
