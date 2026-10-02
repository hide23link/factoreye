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

FACTOREYE_HOST = "http://localhost:8000"
INGEST_API_KEY = "change-this-in-production"
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


def _register_sensor_if_missing(name: str, ingest_key: str, unit: str) -> None:
    body = json.dumps({"name": name, "ingestKey": ingest_key, "unit": unit}).encode("utf-8")
    request = urllib.request.Request(
        f"{FACTOREYE_HOST}/api/sensors",
        data=body,
        headers={"Content-Type": "application/json"},
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


@dataclass
class ManualControl:
    """手動操作画面（control_server.py）のスライダー1本分の状態。"""

    enabled: bool = False
    target: float = 0.0


@dataclass
class MachineState:
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
    print(
        f"テスト工場エミュレータ起動: {MACHINE_NAME}"
        f"（{SEND_INTERVAL_SECONDS:.0f}秒ごとに送信、Ctrl+Cで終了）"
    )

    _register_sensor_if_missing(f"{MACHINE_NAME} 生産数", SENSOR_PRODUCTION, "個")
    _register_sensor_if_missing(f"{MACHINE_NAME} 温度", SENSOR_TEMPERATURE, "°C")
    _register_sensor_if_missing(f"{MACHINE_NAME} 電力", SENSOR_POWER, "kW")

    client = FactorEyeClient(FACTOREYE_HOST, INGEST_API_KEY)
    state = MachineState()
    state_lock = threading.Lock()
    control_server.start(state, state_lock)

    while True:
        with state_lock:
            state.tick(time.monotonic())
            produced = state.units_this_tick()
            temperature = round(state.temperature, 2)
            power = round(state.power, 3)
            is_paused = state.is_paused

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
