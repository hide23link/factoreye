#!/usr/bin/env python3
"""テスト工場エミュレータ: 機械1台を模擬し、5秒ごとに生産数・温度・電力をFactorEyeへ送信する。

backendやclients/配下の公式クライアントとは別物。動作確認・デモ用に、センサーが
無い状態でもダッシュボードにそれらしい変動データを流し込むための「偽の機械」。
本体とは別プロセスとして動かす想定（別ターミナルで `python3 emulator.py` するだけ）。

挙動:
  - 内部的には「生産負荷」指標（0〜100、タクトタイムの逆数のようなもの）がゆるやかに
    ランダムウォークし、これに連動して温度・電力が滑らかに変化する（高負荷ほど高温・
    高消費電力、ノイズと若干の熱慣性付き）
  - 「生産数」センサーに送る値は、その負荷から導いた「直近送信インターバル(5秒)で
    実際に生産した個数」という実カウント値（個。FactorEye側のダッシュボードで
    「直近1時間」「本日累計」のような集計・目標達成率表示に使う前提）
  - 一定確率で「一時停止」に入り、生産数は即座に0個、電力は待機電力へ、温度は
    ゆっくり室温へ戻る。数十秒〜数分でランダムに終わり、通常運転へ復帰する
  - 手動操作画面（http://localhost:8765 、control_server.py）から、生産負荷・温度・
    電力をそれぞれ独立にスライダーで操作できる。「手動」ONにした指標は自動ロジックを
    無視し、スライダーの値へじわじわ収束＋小さなランダム変動になる（しきい値アラームを
    狙って発生/解除させたい時用。詳細はREADME参照）

使い方:
    python3 emulator.py          # Ctrl+C で終了
    手動操作画面: http://localhost:8765 をブラウザで開く

事前準備:
    backendが起動していること（docker-compose up 等）。センサーは初回起動時に
    自動登録される（名前: "テスト機械1号機 生産数/温度/電力"、既存ならスキップ）。
    登録後はFactorEyeの「設定」→「センサー」からいつでも閾値を設定し、
    アラーム機能の動作確認にも使える。
"""
from __future__ import annotations

import getpass
import json
import os
import random
import sys
import threading
import time
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from pathlib import Path

import control_server

# clients/raspberry-pi/factoreye_client.py を再利用する（追加ライブラリ不要、同じ再送/
# バックオフ仕様をそのまま使う）
sys.path.insert(
    0, str(Path(__file__).resolve().parent.parent.parent / "clients" / "raspberry-pi")
)
from factoreye_client import FactorEyeClient  # noqa: E402

# 送信と表示に使う部品: FactorEyeClient（送信・再送）と control_server（手動操作画面）

# 本番の前段は既定の User-Agent（Python-urllib）を拒否するため、このプロセスの全 urllib 通信に名前を付ける
# （共有クライアントの側は変えない）
_opener = urllib.request.build_opener()
_opener.addheaders = [("User-Agent", "factoreye-emulator/1.0")]
urllib.request.install_opener(_opener)

# 既定は手元の self-hosted（ローカル）。SaaS 版へ送る場合は FACTOREYE_HOST と FACTOREYE_TOKEN を
# 環境変数で指定する（トークンはコードに書かない）
FACTOREYE_HOST = os.environ.get("FACTOREYE_HOST", "http://localhost:8000")
FACTOREYE_TOKEN = os.environ.get("FACTOREYE_TOKEN", "")
INGEST_API_KEY = os.environ.get("INGEST_API_KEY", "change-this-in-production")
# 0 以下（既定）なら止めるまで送り続ける。デモ用に時間を区切る場合は秒数を指定する
RUN_SECONDS = float(os.environ.get("EMULATOR_RUN_SECONDS", "0"))
SEND_INTERVAL_SECONDS = 5.0

# センサーのname/ingestKeyは一意制約（論理削除された行にも及ぶ、db/models.py参照）のため、
# 以前のセンサーを削除せずに別名で動かしたい時はEMULATOR_SUFFIXで識別子をずらせる
# （例: EMULATOR_SUFFIX=2 python3 emulator.py）
_SUFFIX = os.environ.get("EMULATOR_SUFFIX", "")
MACHINE_NAME = f"テスト機械1号機{_SUFFIX}"
SENSOR_PRODUCTION = f"machine1-production{_SUFFIX}"
SENSOR_TEMPERATURE = f"machine1-temperature{_SUFFIX}"
SENSOR_POWER = f"machine1-power{_SUFFIX}"

AMBIENT_TEMPERATURE = 22.0
IDLE_POWER_KW = 0.4

# 一時停止の起こりやすさ・長さ（1tick=5秒として、平均で数分に1回程度を想定）
PAUSE_CHANCE_PER_TICK = 0.02
PAUSE_DURATION_RANGE_SECONDS = (15.0, 90.0)

# 生産負荷100%の時、1tick(5秒)あたりに生産する個数の目安。ノイズ幅を±0.5に抑えることで、
# 通常運転中（負荷は最低でも30%）は生産数が0個に張り付かず（＝稼働中判定がチラつかず）、
# それでいて毎回同じ値にならない程度のばらつきが出るようにしている
MAX_UNITS_PER_TICK = 5.0
UNITS_NOISE_RANGE = (-0.5, 0.5)


def _login_for_token() -> str:
    """FACTOREYE_EMAIL が指定されていれば、パスワードを画面に出さずに聞いてログインし、トークンを返す。

    パスワードもトークンも、ファイルには書かない（メモリ上だけで使う）。
    """
    email = os.environ.get("FACTOREYE_EMAIL", "")
    if not email:
        return ""
    password = getpass.getpass(f"{email} のパスワード（入力は表示されません）: ")
    body = json.dumps({"email": email, "password": password}).encode("utf-8")
    del password  # 使い終わったパスワードは、変数から消しておく（残さないため）
    request = urllib.request.Request(
        f"{FACTOREYE_HOST}/api/auth/login",
        data=body,
        headers={"Content-Type": "application/json", **_USER_AGENT},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=10.0) as response:
            return str(json.loads(response.read())["accessToken"])
    except urllib.error.HTTPError as exc:
        raise SystemExit(f"ログインに失敗しました（HTTP {exc.code}）。メールとパスワードを確認してください") from None


# 既定の User-Agent（Python-urllib）は本番の前段で拒否されるため、名前を付けて送る
# （この関数で使う定数。上で定義済みの opener の設定と同じ値）
_USER_AGENT = {"User-Agent": "factoreye-emulator/1.0"}


def _auth_headers() -> dict[str, str]:
    """通信に付ける共通のヘッダー（User-Agent と、トークンがあれば Authorization）。"""
    headers = dict(_USER_AGENT)
    if FACTOREYE_TOKEN:
        headers["Authorization"] = f"Bearer {FACTOREYE_TOKEN}"
    return headers


def _register_sensor_if_missing(name: str, ingest_key: str, unit: str) -> None:
    """センサーを登録する。既に登録済み（409）なら、そのまま使う（何もしない）。"""
    body = json.dumps({"name": name, "ingestKey": ingest_key, "unit": unit}).encode("utf-8")
    request = urllib.request.Request(
        f"{FACTOREYE_HOST}/api/sensors",
        data=body,
        headers={"Content-Type": "application/json", **_auth_headers()},
        method="POST",
    )
    try:
        with urllib.request.urlopen(request, timeout=5.0):
            print(f"センサーを登録しました: {name} ({ingest_key})")
    except urllib.error.HTTPError as exc:
        if exc.code == 409:
            print(f"センサーは登録済みです: {name} ({ingest_key})")
        else:
            raise


def _verify_own_sensors(ingest_keys: list[str]) -> None:
    """SaaS 版のとき: 送信先のキーが、ログイン中のワークスペースのセンサーであることを確かめる。

    取り込みキーは全体で一意なので、別のワークスペースのセンサーに送ってしまう事故を防ぐ。
    """
    request = urllib.request.Request(
        f"{FACTOREYE_HOST}/api/sensors", headers=_auth_headers(), method="GET"
    )
    with urllib.request.urlopen(request, timeout=5.0) as response:
        own = {sensor["ingestKey"] for sensor in json.loads(response.read())}
    missing = [key for key in ingest_keys if key not in own]
    if missing:
        raise SystemExit(f"このワークスペースに無いセンサーです（送信を中止）: {missing}")


# ──────────────────────────────────────────────────────────────
# 機械の状態（自動の挙動と、手動操作の両方を持つ）
# ──────────────────────────────────────────────────────────────


@dataclass
class ManualControl:
    """手動操作画面（control_server.py）のスライダー1本分の状態。"""

    enabled: bool = False
    target: float = 0.0


@dataclass
class MachineState:
    """機械1台の状態。5 秒ごとに tick() で進め、その値をセンサーとして送る。

    値の関係: 生産負荷 → 生産数（個）・温度・電力。負荷が高いほど、温度と電力が上がる。
    """

    production_rate: float = 70.0  # 現在の生産負荷の指標（0〜100。温度・電力の計算にのみ使う内部値）
    temperature: float = AMBIENT_TEMPERATURE
    power: float = IDLE_POWER_KW
    paused_until: float | None = None  # time.monotonic()での再開予定時刻（稼働中はNone）

    # 手動操作画面から独立に切り替え可能。手動時はそれぞれ自動ロジックを無視し、
    # targetへじわじわ収束＋小さなノイズになる
    production_control: ManualControl = field(
        default_factory=lambda: ManualControl(target=70.0)
    )
    temperature_control: ManualControl = field(
        default_factory=lambda: ManualControl(target=AMBIENT_TEMPERATURE)
    )
    power_control: ManualControl = field(default_factory=lambda: ManualControl(target=IDLE_POWER_KW))

    @property
    def is_paused(self) -> bool:
        return self.paused_until is not None

    def units_this_tick(self) -> int:
        """このtick(5秒)で実際に生産した個数。負荷指標（手動/自動いずれでも）から導く。"""
        if self.is_paused:
            return 0
        expected = self.production_rate / 100.0 * MAX_UNITS_PER_TICK
        noisy = expected + random.uniform(*UNITS_NOISE_RANGE)
        return max(0, round(noisy))

    def tick(self, now: float) -> None:
        """5 秒に1回、状態を1段階進める（手動・一時停止・通常運転のどれか）。

        now は time.monotonic() の現在時刻（一時停止の終わりを判定するため）。
        """
        if self.production_control.enabled:
            # 手動モード: 一時停止ロジックは無視し、スライダーのtargetへ収束＋ノイズ
            self.paused_until = None
            self.production_rate += (self.production_control.target - self.production_rate) * 0.5
            self.production_rate += random.uniform(-2.0, 2.0)
            self.production_rate = max(0.0, min(100.0, self.production_rate))
        elif self.paused_until is not None:
            if now >= self.paused_until:
                self.paused_until = None
                print("▶ 稼働再開")
            else:
                self.production_rate = 0.0
        elif random.random() < PAUSE_CHANCE_PER_TICK:
            duration = random.uniform(*PAUSE_DURATION_RANGE_SECONDS)
            self.paused_until = now + duration
            print(f"⏸ 一時停止します（約{duration:.0f}秒）")
            self.production_rate = 0.0
        else:
            # 通常運転: 生産負荷がゆるやかにランダムウォーク（30〜100の範囲に収める）
            self.production_rate += random.uniform(-8.0, 8.0)
            self.production_rate = max(30.0, min(100.0, self.production_rate))

        self._update_temperature()
        self._update_power()

    def _update_temperature(self) -> None:
        """指数平滑で目標値へゆっくり近づける（実機の熱慣性を簡易に模擬）。
        手動時はスライダーのtargetそのものが目標値になる。"""
        if self.temperature_control.enabled:
            target = self.temperature_control.target
            self.temperature += (target - self.temperature) * 0.5 + random.uniform(-0.3, 0.3)
        else:
            target = AMBIENT_TEMPERATURE + self.production_rate * 0.25
            self.temperature += (target - self.temperature) * 0.3 + random.uniform(-0.2, 0.2)

    def _update_power(self) -> None:
        if self.power_control.enabled:
            target = self.power_control.target
            self.power += (target - self.power) * 0.5 + random.uniform(-0.05, 0.05)
        else:
            target = (
                IDLE_POWER_KW if self.is_paused else IDLE_POWER_KW + self.production_rate * 0.08
            )
            self.power += (target - self.power) * 0.5 + random.uniform(-0.03, 0.03)
        self.power = max(0.0, self.power)

    def to_control_dict(self) -> dict[str, object]:
        """手動操作画面（/state）向けの現在値・モード・目標値のスナップショット。"""
        return {
            "production": {
                "value": round(self.production_rate, 1),
                "manual": self.production_control.enabled,
                "target": self.production_control.target,
            },
            "temperature": {
                "value": round(self.temperature, 2),
                "manual": self.temperature_control.enabled,
                "target": self.temperature_control.target,
            },
            "power": {
                "value": round(self.power, 3),
                "manual": self.power_control.enabled,
                "target": self.power_control.target,
            },
            "paused": self.is_paused,
        }

    def apply_control(self, payload: dict[str, object]) -> None:
        """手動操作画面（POST /control）からの更新を反映する。"""
        controls: dict[str, ManualControl] = {
            "production": self.production_control,
            "temperature": self.temperature_control,
            "power": self.power_control,
        }
        for key, control in controls.items():
            entry = payload.get(key)
            if not isinstance(entry, dict):
                continue
            if "manual" in entry:
                control.enabled = bool(entry["manual"])
            if "target" in entry:
                control.target = float(entry["target"])  # type: ignore[arg-type]


def main() -> None:
    """エミュレータの本体。起動時にログイン（必要なら）とセンサー登録を行い、5 秒ごとに送り続ける。"""
    global FACTOREYE_TOKEN
    if not FACTOREYE_TOKEN:
        FACTOREYE_TOKEN = _login_for_token()
    print(
        f"テスト工場エミュレータ起動: {MACHINE_NAME}"
        f"（{SEND_INTERVAL_SECONDS:.0f}秒ごとに送信、Ctrl+Cで終了）"
    )

    _register_sensor_if_missing(f"{MACHINE_NAME} 生産数", SENSOR_PRODUCTION, "個")
    _register_sensor_if_missing(f"{MACHINE_NAME} 温度", SENSOR_TEMPERATURE, "°C")
    _register_sensor_if_missing(f"{MACHINE_NAME} 電力", SENSOR_POWER, "kW")
    if FACTOREYE_TOKEN:
        _verify_own_sensors([SENSOR_PRODUCTION, SENSOR_TEMPERATURE, SENSOR_POWER])

    # 送信のクライアントと、機械の状態。手動操作画面（別スレッド）と状態を共有するので、ロックで守る
    client = FactorEyeClient(FACTOREYE_HOST, INGEST_API_KEY)
    state = MachineState()
    state_lock = threading.Lock()
    control_server.start(state, state_lock)
    started = time.monotonic()

    # 繰り返し: 状態を進め、3 つの値を送り、結果を表示する。時間の指定があれば、その時間で止める
    while True:
        if RUN_SECONDS > 0 and time.monotonic() - started >= RUN_SECONDS:
            print("指定時間が経過したので終了します。")
            break
        # 状態の読み書きは、ロックの中で行う（手動操作画面と同時に触らないため）
        with state_lock:
            state.tick(time.monotonic())
            produced = state.units_this_tick()
            temperature = round(state.temperature, 2)
            power = round(state.power, 3)
            is_paused = state.is_paused

        # 3 つのセンサーに、それぞれ送る（送れなければ、クライアントが溜めて次に再送する）
        client.send(SENSOR_PRODUCTION, produced)
        client.send(SENSOR_TEMPERATURE, temperature)
        client.send(SENSOR_POWER, power)

        status = "一時停止中" if is_paused else "稼働中  "
        print(
            f"[{status}] 生産数={produced:2d}個  "
            f"温度={temperature:5.1f}°C  電力={power:4.2f}kW  "
            f"(未送信バッファ: {client.pending_count}件)"
        )

        time.sleep(SEND_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n停止しました。")
