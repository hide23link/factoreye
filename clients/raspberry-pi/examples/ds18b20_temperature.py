#!/usr/bin/env python3
"""DS18B20（1-Wire温度センサー）の値をFactorEyeへ送る例。

DS18B20はRaspberry PiのGPIOに直結できる定番の防水温度センサー。カーネルの1-Wire
ドライバがセンサー値を /sys/bus/w1/devices/28-xxxxxxxxxxxx/w1_slave に公開するため、
追加のPythonライブラリなし（標準ライブラリのみ）で読み取れる。

事前準備:
    1. DS18B20をGPIO4（デフォルト）に接続（データ線とVCC間に4.7kΩのプルアップ抵抗）
    2. /boot/firmware/config.txt（旧: /boot/config.txt）に以下を追記して再起動
           dtoverlay=w1-gpio
       （raspi-config の "Interface Options > 1-Wire" からでも有効化可能）
    3. FactorEyeの設定画面で、下記 INGEST_KEY と同じ ingestKey を持つセンサーを
       先に登録しておく（単位は "C" 等）

実行:
    python3 ds18b20_temperature.py
"""
from __future__ import annotations

import glob
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from factoreye_client import FactorEyeClient  # noqa: E402

FACTOREYE_HOST = "http://192.168.1.50:8000"
INGEST_API_KEY = "change-this-in-production"
INGEST_KEY = "rpi-ds18b20-1"
SEND_INTERVAL_SECONDS = 10.0

_W1_DEVICE_GLOB = "/sys/bus/w1/devices/28-*/w1_slave"


def _find_sensor_path() -> str:
    matches = glob.glob(_W1_DEVICE_GLOB)
    if not matches:
        raise RuntimeError(
            "DS18B20が見つかりません。dtoverlay=w1-gpio の設定と配線を確認してください。"
        )
    return matches[0]


def _read_temperature_c(sensor_path: str) -> float:
    content = Path(sensor_path).read_text()
    lines = content.strip().splitlines()
    if len(lines) != 2 or not lines[0].endswith("YES"):
        raise RuntimeError("CRCチェック失敗、またはセンサー読み取りエラー")

    # 2行目の "t=12345" は摂氏の1000倍（12.345度ならt=12345）
    _, _, temp_part = lines[1].rpartition("t=")
    return int(temp_part) / 1000.0


def main() -> None:
    sensor_path = _find_sensor_path()
    print(f"DS18B20を検出: {sensor_path}")

    client = FactorEyeClient(FACTOREYE_HOST, INGEST_API_KEY)

    while True:
        value = _read_temperature_c(sensor_path)
        ok = client.send(INGEST_KEY, value)
        status = "送信成功" if ok else "送信失敗/バッファ待機中"
        print(f"value={value:.3f}  {status}  (未送信バッファ: {client.pending_count}件)")
        time.sleep(SEND_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
