# FactorEyeClient（Raspberry Pi 用 Python クライアント）

Raspberry Pi の GPIO / 1-Wire センサーの値を、FactorEye へ送る最小クライアントです。
[M5Stack 向けライブラリ](../arduino-m5stack/)と同じ設計（シンプルな呼び出し・指数バックオフ・オフラインバッファ）です。

```python
from factoreye_client import FactorEyeClient

client = FactorEyeClient("http://192.168.1.50:8000", "your-ingest-api-key")
client.send("rpi-temp-1", 25.3)
```

標準ライブラリだけで動きます。`factoreye_client.py` 1 ファイルをコピーすれば使えます。

## ファイル構成

```
raspberry-pi/
├── factoreye_client.py           本体
├── examples/
│   ├── ds18b20_temperature.py    1-Wire 温度センサー（追加ライブラリ不要）
│   └── gpio_digital_input.py     GPIO のデジタル入力（gpiozero）
└── tests/test_factoreye_client.py
```

## 使い方

- **センサーを先に登録する**
  - `send()` の `ingest_key` は、FactorEye に登録済みのセンサーのキーと一致させる
  - 未登録だと 404 になる。「設定 → センサー」か、セットアップガイドで登録する
- **API キー**（第 2 引数）
  - self-hosted: backend の `INGEST_API_KEY` と同じ値
  - `INGEST_AUTH=off` のとき: 空文字（`""`）。`X-API-Key` ヘッダーは付かない

## 送信の挙動

- 通常は、即座に 1 回 POST して、成否（`True` / `False`）を返す
- 失敗した値は、最大 100 件のリングバッファに保持し、次の `send()` でまとめて再送する
  - 待ち時間は 1・2・4・8・16 秒、上限 30 秒（±10% のジッター）
  - 待機中の `send()` は、通信せずに値を積むだけで即座に返る
  - バッファが満杯なら、古い値から捨てる
- 失敗の種類による扱いは [`docs/architecture.md`](../../docs/architecture.md) §9 のとおり（M5Stack 版と同じ）
- `client.pending_count` で、未送信の件数を取得できる

## 例

- `examples/ds18b20_temperature.py`: 防水温度センサー DS18B20。1-Wire の有効化（`dtoverlay=w1-gpio`）だけで動く
- `examples/gpio_digital_input.py`: ドアセンサーや人感センサーの ON/OFF を 1.0 / 0.0 で送る

## テスト

```bash
cd clients/raspberry-pi
python3 -m unittest tests.test_factoreye_client -v
```

追加ライブラリは不要です（`http.server` で自前のモックを起動します）。

## 制限

- タイムスタンプは送らない（FactorEye は受信時刻を採用する）
- 1 回の `send()` で送れる `ingest_key` は 1 つ
- 動作確認は Python 3.8 以降（Raspberry Pi OS Bookworm の Python 3.11 でも動く想定）

## ライセンス

MIT（リポジトリの [LICENSE](../../LICENSE)）。
