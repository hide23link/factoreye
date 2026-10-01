#!/usr/bin/env python3
"""GPIOのデジタル入力（ドアセンサー・人感センサー等）をFactorEyeへ送る例。

architecture docの「raspberry-pi-rest-adapter（GPIO→REST）」の典型例: ON/OFFのデジタル
信号を 1.0/0.0 の値としてFactorEyeに送る。Raspberry Pi OSに標準で入っている gpiozero
を使う（入っていない環境では `pip install gpiozero` で追加）。

事前準備:
    1. センサーをGPIO17（デフォルト、BCM番号）に接続
    2. FactorEyeの設定画面で、下記 INGEST_KEY と同じ ingestKey を持つセンサーを
       先に登録しておく（単位は "bool" 等、閾値は使わずAlarmAlert代わりに値0/1で監視）

実行:
    python3 gpio_digital_input.py
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

from gpiozero import DigitalInputDevice

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from factoreye_client import FactorEyeClient  # noqa: E402

FACTOREYE_HOST = "http://192.168.1.50:8000"
INGEST_API_KEY = "change-this-in-production"
INGEST_KEY = "rpi-door-sensor-1"
GPIO_PIN = 17
SEND_INTERVAL_SECONDS = 5.0


def main() -> None:
    sensor = DigitalInputDevice(GPIO_PIN)
    client = FactorEyeClient(FACTOREYE_HOST, INGEST_API_KEY)

    while True:
        value = 1.0 if sensor.is_active else 0.0
        ok = client.send(INGEST_KEY, value)
        status = "送信成功" if ok else "送信失敗/バッファ待機中"
        print(f"value={value}  {status}  (未送信バッファ: {client.pending_count}件)")
        time.sleep(SEND_INTERVAL_SECONDS)


if __name__ == "__main__":
    main()
