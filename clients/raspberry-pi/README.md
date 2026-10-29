# raspberry-pi-rest-adapter（Raspberry Pi 用 Python クライアント）

Raspberry Pi の GPIO / 1-Wire センサーの値を、FactorEye の[センサー Ingest API](../../docs/architecture.md)（`POST /api/ingest/readings`）へ送るための最小クライアントです。[M5Stack 向けの Arduino ライブラリ](../arduino-m5stack/)と同じ設計（簡単な呼び出し、指数バックオフ、オフラインバッファ）です。

```python
from factoreye_client import FactorEyeClient

client = FactorEyeClient("http://192.168.1.50:8000", "your-ingest-api-key")
client.send("rpi-temp-1", 25.3)
```

依存ライブラリはありません（標準ライブラリのみ）。Raspberry Pi OS 標準の Python 3 でそのまま動きます。

## ファイル構成

```
raspberry-pi/
├── factoreye_client.py              ← 本体（このファイルだけコピーしても使える）
├── examples/
│   ├── ds18b20_temperature.py       ← 1-Wire 温度センサーの例（追加ライブラリ不要）
│   └── gpio_digital_input.py        ← GPIO デジタル入力の例（gpiozero 使用）
└── tests/
    └── test_factoreye_client.py     ← 単体テスト（ローカルの HTTP サーバーで ingest API をモック）
```

## 使い方

### 1. センサーを先に登録する

`send()` の `ingest_key` は、FactorEye に登録済みのセンサーの `ingestKey` と一致している必要があります（未登録なら 404）。画面の「設定」→「センサー」、またはセットアップガイドから登録してください。自動登録（`INGEST_AUTO_CREATE=on`、self-hosted のみ）を使う場合は不要です。

### 2. APIキー

コンストラクタの第 2 引数は、backend の `INGEST_API_KEY` と同じ値です。backend を `INGEST_AUTH=off` で動かしているときは空文字（`""`）を渡します（そのときは `X-API-Key` を付けずに送ります）。

### 3. 送信の挙動

- `send(ingest_key, value)` は、通常は即座に 1 回 POST し、成否（`True` / `False`）を返します
- 送れなかった値はリングバッファ（最大 100 件）に保持し、次回以降の `send()` でまとめて再送します。待機は指数バックオフ（上限 30 秒）で、待機中の `send()` は通信せずに積むだけで戻ります
- 再送の対象、保持の上限、捨てる条件は、[`docs/architecture.md`](../../docs/architecture.md) §9 の「送信失敗時の再送（デバイス側）」に従います（Arduino 版と同じ仕様）
- `client.pending_count` で、バッファに溜まっている未送信件数を取得できます

### 付属の実例

- **`examples/ds18b20_temperature.py`**: 防水温度センサー DS18B20 の値を送る。1-Wire を有効にすれば（`dtoverlay=w1-gpio`）、追加のライブラリは不要
- **`examples/gpio_digital_input.py`**: ドアセンサーや人感センサーの ON/OFF を 1.0 / 0.0 の値として送る（`gpiozero` を使用）

実センサーが無い環境でも、`factoreye_client.py` を import してテストデータを送れます。

### テストの実行

```bash
cd clients/raspberry-pi
python3 -m unittest tests.test_factoreye_client -v
```

## 制限事項

- タイムスタンプは送りません。backend は受信時刻を採用します（デバイスの時刻は信頼しない設計）
- 1 回の `send()` で対象にできる `ingest_key` は 1 つです
- 動作確認は Python 3.8 以降で実施（Raspberry Pi OS Bookworm 標準の Python 3.11 でも動作を想定）

## ライセンス

MIT（`LICENSE` 参照）。
