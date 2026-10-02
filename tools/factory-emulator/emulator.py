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

使い方:
    python3 emulator.py          # Ctrl+C で終了

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
import time
import urllib.error
import urllib.request
from dataclasses import dataclass
from pathlib import Path

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
class MachineState:
    production_rate: float = 70.0  # 現在の生産負荷の指標（0〜100。温度・電力の計算にのみ使う内部値）
    temperature: float = AMBIENT_TEMPERATURE
    power: float = IDLE_POWER_KW
    paused_until: float | None = None  # time.monotonic()での再開予定時刻（稼働中はNone）

    @property
    def is_paused(self) -> bool:
        return self.paused_until is not None

    def units_this_tick(self) -> int:
        """このtick(5秒)で実際に生産した個数。負荷指標から導く実カウント値。"""
        if self.is_paused:
            return 0
        expected = self.production_rate / 100.0 * MAX_UNITS_PER_TICK
        noisy = expected + random.uniform(*UNITS_NOISE_RANGE)
        return max(0, round(noisy))

    def tick(self, now: float) -> None:
        if self.paused_until is not None:
            if now >= self.paused_until:
                self.paused_until = None
                print("▶ 稼働再開")
            else:
                self.production_rate = 0.0
                self._settle_toward(target_power=IDLE_POWER_KW)
                return
        elif random.random() < PAUSE_CHANCE_PER_TICK:
            duration = random.uniform(*PAUSE_DURATION_RANGE_SECONDS)
            self.paused_until = now + duration
            print(f"⏸ 一時停止します（約{duration:.0f}秒）")
            self.production_rate = 0.0
            self._settle_toward(target_power=IDLE_POWER_KW)
            return

        # 通常運転: 生産負荷がゆるやかにランダムウォーク（30〜100の範囲に収める）
        self.production_rate += random.uniform(-8.0, 8.0)
        self.production_rate = max(30.0, min(100.0, self.production_rate))
        target_power = IDLE_POWER_KW + self.production_rate * 0.08
        self._settle_toward(target_power=target_power)

    def _settle_toward(self, target_power: float) -> None:
        """温度・電力を指数平滑で目標値へゆっくり近づける（実機の熱慣性を簡易に模擬）。"""
        target_temperature = AMBIENT_TEMPERATURE + self.production_rate * 0.25
        self.temperature += (
            (target_temperature - self.temperature) * 0.3 + random.uniform(-0.2, 0.2)
        )
        self.power += (target_power - self.power) * 0.5 + random.uniform(-0.03, 0.03)
        self.power = max(0.0, self.power)


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

    while True:
        state.tick(time.monotonic())
        produced = state.units_this_tick()

        client.send(SENSOR_PRODUCTION, produced)
        client.send(SENSOR_TEMPERATURE, round(state.temperature, 2))
        client.send(SENSOR_POWER, round(state.power, 3))

        status = "一時停止中" if state.is_paused else "稼働中  "
        print(
            f"[{status}] 生産数={produced:2d}個  "
            f"温度={state.temperature:5.1f}°C  電力={state.power:4.2f}kW  "
            f"(未送信バッファ: {client.pending_count}件)"
        )

        time.sleep(SEND_INTERVAL_SECONDS)


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\n停止しました。")
