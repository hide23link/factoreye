"""バックエンドのコンテナの中で動かす: 試験用のセンサー（3 要素 × SITES か所）と機器を作り、機器ごとのキーを発行する。

標準入力から `python -` で実行する（setup_devices.sh が呼ぶ）。環境変数 SITES（か所の数）。
出力: 1 機器につき 1 行 `NN <キー> <所属できなかった数>`。キーはこの 1 回だけ出る。
センサーの ingestKey は ld<NN>-v / -i / -e、機器の名前は r-load-<NN>（NN は 01〜）。
"""
import asyncio
import json
import os
import urllib.request

from app import device_keys
from app.db.session import engine
from sqlmodel.ext.asyncio.session import AsyncSession

SITES = int(os.environ["SITES"])
LABELS = (("v", "電圧", "V"), ("i", "電流", "A"), ("e", "電位", "V"))

for n in range(1, SITES + 1):
    for suffix, label, unit in LABELS:
        body = json.dumps(
            {"name": f"負荷試験 {n:02d} {label}", "ingestKey": f"ld{n:02d}-{suffix}", "unit": unit}
        ).encode()
        req = urllib.request.Request(
            "http://127.0.0.1:8000/api/sensors",
            data=body,
            headers={"Content-Type": "application/json"},
            method="POST",
        )
        urllib.request.urlopen(req, timeout=10)


async def main() -> None:
    async with AsyncSession(engine) as session:
        for n in range(1, SITES + 1):
            name = f"r-load-{n:02d}"
            key = await device_keys.create_device(session, name)
            device = await device_keys.get_device_by_name(session, name)
            assert device is not None
            keys = [f"ld{n:02d}-{suffix}" for suffix, _, _ in LABELS]
            missing = await device_keys.attach_sensors(session, device, keys)
            print(f"{n:02d} {key} {len(missing)}")
    await engine.dispose()


asyncio.run(main())
