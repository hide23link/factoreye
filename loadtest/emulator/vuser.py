"""仮想ユーザー。1人分のワークスペース（センサー・ダッシュボード）と、送信・閲覧・設定変更を行う。

- 送信: センサーごとに send_interval_s（±jitter）で /api/ingest/readings に値を送る
- 閲覧: viewer_interval_s ごとに、センサー一覧・測定値・アラーム・ダッシュボードを読む
- 設定変更: 閲覧の合間に一定確率でセンサーのしきい値を書き換える（更新系の負荷）

シナリオ（Runner.scenario）は毎回参照するので、画面から変えた値はすぐ反映される。
"""
import asyncio
import random
from dataclasses import dataclass
from typing import Protocol

from emulator import values
from emulator.api_client import ApiClient
from emulator.scenario import Scenario

_THRESHOLD_WRITE_PROBABILITY = 0.1


class ScenarioSource(Protocol):
    @property
    def scenario(self) -> Scenario: ...


@dataclass
class SensorHandle:
    id: str
    ingest_key: str


class VirtualUser:
    def __init__(
        self,
        index: int,
        run_id: str,
        source: ScenarioSource,
        client: ApiClient,
        seed: int,
    ) -> None:
        self.index = index
        self._source = source
        self._client = client
        self._rng = random.Random(seed)
        prefix = source.scenario.email_prefix
        self._run_id = run_id
        self.email = f"{prefix}-{run_id}-{index:03d}@example.com"
        self._token: str | None = None
        self.sensors: list[SensorHandle] = []
        self._sender_tasks: dict[int, asyncio.Task[None]] = {}
        self._viewer_tasks: list[asyncio.Task[None]] = []
        self._t0 = 0.0
        self.started = False

    # ── セットアップ ───────────────────────────────────────

    async def setup(self) -> bool:
        """登録（既存なら省略）→ ログイン → ダッシュボード作成。成功なら True。"""
        sc = self._source.scenario
        reg = await self._client.call(
            "register",
            "POST",
            "/api/auth/register",
            json={
                "email": self.email,
                "password": sc.password,
                "workspaceName": f"負荷テスト {self.index:03d}",
            },
        )
        if reg is None:
            return False
        if reg.status_code == 201:
            self._token = reg.json()["accessToken"]
        else:
            if not await self._login():
                return False

        await self._client.call(
            "dashboard_create",
            "POST",
            "/api/dashboards",
            json={"name": f"ダッシュボード {self.index:03d}"},
            token=self._token,
        )
        self._t0 = asyncio.get_running_loop().time()
        return True

    async def _login(self) -> bool:
        sc = self._source.scenario
        resp = await self._client.call(
            "login",
            "POST",
            "/api/auth/login",
            json={"email": self.email, "password": sc.password},
        )
        if resp is None or resp.status_code != 200:
            return False
        self._token = resp.json()["accessToken"]
        return True

    async def ensure_sensors(self) -> None:
        """シナリオのセンサー数に合わせて作成する。無料プラン上限（402）に達したら止める。"""
        wanted = self._source.scenario.sensors_per_user
        while len(self.sensors) < wanted:
            n = len(self.sensors) + 1
            # センサー名・ingestKey はDBで一意なので、実行IDを含めて実行ごとに被らせない
            key = f"lt-{self._run_id}-{self.index:03d}-{n:02d}-{self._rng.getrandbits(32):08x}"
            resp = await self._client.call(
                "sensor_create",
                "POST",
                "/api/sensors",
                json={"name": key, "ingestKey": key, "unit": "count"},
                token=self._token,
            )
            if resp is None or resp.status_code != 201:
                return
            self.sensors.append(SensorHandle(id=resp.json()["id"], ingest_key=key))

    # ── 実行 ─────────────────────────────────────────────

    def start(self) -> None:
        for i, sensor in enumerate(self.sensors):
            self._start_sender(i, sensor)
        self._reconcile_viewers()
        self.started = True

    def reconcile(self) -> None:
        """実行中にシナリオが変わったときの調整（センサー数・閲覧者数）。"""
        wanted = self._source.scenario.sensors_per_user
        for i, sensor in enumerate(self.sensors[:wanted]):
            if i not in self._sender_tasks or self._sender_tasks[i].done():
                self._start_sender(i, sensor)
        for i in list(self._sender_tasks):
            if i >= wanted:
                self._sender_tasks.pop(i).cancel()
        self._reconcile_viewers()

    def _start_sender(self, i: int, sensor: SensorHandle) -> None:
        self._sender_tasks[i] = asyncio.create_task(self._sender(sensor))

    def _reconcile_viewers(self) -> None:
        wanted = self._source.scenario.viewers_per_user
        self._viewer_tasks = [t for t in self._viewer_tasks if not t.done()]
        while len(self._viewer_tasks) < wanted:
            self._viewer_tasks.append(asyncio.create_task(self._viewer()))
        while len(self._viewer_tasks) > wanted:
            self._viewer_tasks.pop().cancel()

    async def stop(self) -> None:
        tasks = [*self._sender_tasks.values(), *self._viewer_tasks]
        for t in tasks:
            t.cancel()
        await asyncio.gather(*tasks, return_exceptions=True)
        self._sender_tasks.clear()
        self._viewer_tasks.clear()

    async def _sender(self, sensor: SensorHandle) -> None:
        # 起動を揃えないよう、最初の送信はランダムにずらす
        await asyncio.sleep(self._rng.uniform(0, self._source.scenario.send_interval_s))
        while True:
            sc = self._source.scenario
            elapsed = asyncio.get_running_loop().time() - self._t0
            value = values.generate(
                sc.value_profile,
                elapsed,
                self._rng,
                sc.value_base,
                sc.value_amplitude,
                sc.spike_probability,
            )
            await self._client.call(
                "ingest",
                "POST",
                "/api/ingest/readings",
                json={"ingestKey": sensor.ingest_key, "value": round(value, 3)},
            )
            await asyncio.sleep(sc.send_interval_s + self._rng.uniform(0, sc.jitter_s))

    async def _viewer(self) -> None:
        while True:
            sc = self._source.scenario
            await asyncio.sleep(sc.viewer_interval_s * self._rng.uniform(0.5, 1.5))
            roll = self._rng.random()
            if roll < _THRESHOLD_WRITE_PROBABILITY and self.sensors:
                await self._update_threshold()
            elif roll < 0.4:
                await self._get("view_sensors", "/api/sensors")
            elif roll < 0.7 and self.sensors:
                sensor = self._rng.choice(self.sensors)
                await self._get(
                    "view_readings",
                    f"/api/sensors/{sensor.id}/readings",
                    params={"limit": "50"},
                )
            elif roll < 0.85:
                await self._get("view_alarms", "/api/alarms")
            else:
                await self._get("view_dashboards", "/api/dashboards")

    async def _get(self, name: str, path: str, params: dict[str, str] | None = None) -> None:
        resp = await self._client.call(name, "GET", path, params=params, token=self._token)
        if resp is not None and resp.status_code == 401:
            # アクセストークンの期限切れ（15分）。再ログインして1回だけ再試行する
            if await self._login():
                await self._client.call(name, "GET", path, params=params, token=self._token)

    async def _update_threshold(self) -> None:
        sensor = self._rng.choice(self.sensors)
        resp = await self._client.call(
            "update_threshold",
            "PUT",
            f"/api/sensors/{sensor.id}",
            json={"thresholdMaxCritical": round(self._rng.uniform(60, 90), 1)},
            token=self._token,
        )
        if resp is not None and resp.status_code == 401 and await self._login():
            await self._client.call(
                "update_threshold",
                "PUT",
                f"/api/sensors/{sensor.id}",
                json={"thresholdMaxCritical": round(self._rng.uniform(60, 90), 1)},
                token=self._token,
            )
