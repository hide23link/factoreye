# raspberry-pi-rest-adapter（Raspberry Pi 用 Pythonクライアント）

Raspberry PiのGPIO/1-Wire/I2Cセンサーの値を、FactorEyeの
[センサーIngest API](../../docs/factoreye-architecture.md)（`POST /api/ingest/readings`）へ
送るための最小クライアントです。[M5Stack向けArduinoライブラリ](../arduino-m5stack/)と
同じ設計方針（Ambientライブラリ風のシンプルな呼び出し、指数バックオフ、オフラインバッファ）
を採用しています。

```python
from factoreye_client import FactorEyeClient

client = FactorEyeClient("http://192.168.1.50:8000", "your-ingest-api-key")
client.send("rpi-temp-1", 25.3)
```

依存ライブラリはありません（標準ライブラリのみ）。Raspberry Pi OS標準のPython 3で
そのまま動きます。

## ファイル構成

```
raspberry-pi/
├── factoreye_client.py              ← 本体（これ1ファイルをコピーするだけでも使える）
├── examples/
│   ├── ds18b20_temperature.py       ← 1-Wire温度センサーの例（配線のみ、追加ライブラリ不要）
│   └── gpio_digital_input.py        ← GPIOデジタル入力の例（gpiozero使用）
└── tests/
    └── test_factoreye_client.py     ← 単体テスト（ローカルHTTPサーバーでingest APIをモック）
```

## 使い方

### 1. センサーを先に登録する

`send()` で使う `ingest_key` は、FactorEye側に事前に登録されているセンサーの `ingestKey`
と一致している必要があります（未登録のキーで送ると404になります）。FactorEyeの設定画面
（「設定」→「センサー」）、またはセットアップガイドから登録してください。

### 2. APIキー

コンストラクタの第2引数は、backendの `.env` に設定した `INGEST_API_KEY` と同じ値を
使います（self-hosted運用ではインストールごとに1つの共有シークレット）。

### 3. 送信の挙動（オフライン対応）

`send(ingest_key, value)` は以下のように動きます:

- 通常時: 即座に1回POSTし、成否（`True`/`False`）を返す
- 送信に失敗した場合: 値を内部のリングバッファ（最大100件）に保持し、次回以降の`send()`で
  まとめて再送を試みる。再送のタイミングは指数バックオフ（1秒→2秒→4秒→8秒→16秒→上限30秒、
  ±10%のジッター付き）に従う
- バックオフ待機中に呼ばれた`send()`は通信を試みず、値をバッファに積むだけで即座に返る
  （呼び出し元のループをブロックしない）
- バッファが満杯のときは最も古い値から捨てられる

この挙動は `docs/factoreye-architecture.md` §Sensor Data Ingest の
「デバイス側リトライ（指数バックオフ）」の仕様に準拠しており、M5Stack向けArduinoライブラリ
と同じ挙動です。

`client.pending_count` で現在バッファに溜まっている未送信件数を取得できます。

### 付属の実例

- **`examples/ds18b20_temperature.py`**: 定番の防水温度センサーDS18B20の値を送信。
  1-Wireの有効化（`dtoverlay=w1-gpio`）さえすれば、追加のPythonライブラリ不要で動く。
- **`examples/gpio_digital_input.py`**: ドアセンサーや人感センサーなどのON/OFF信号を
  1.0/0.0の値として送信。Raspberry Pi OS標準の`gpiozero`を使用。

実センサーが無い環境でも、`factoreye_client.py` 単体をimportしてテストデータを
送ることはできます。

### テストの実行

```bash
cd clients/raspberry-pi
python3 -m unittest tests.test_factoreye_client -v
```

pytestやモックサーバー用の追加ライブラリは不要（`http.server`で自前のモックを起動する）。

## 制限事項（Phase 0）

- タイムスタンプは送信しません。FactorEyeバックエンドは受信時刻を採用し、デバイス側の
  時刻は信頼しない設計のためです（`docs/factoreye-architecture.md` 参照）。
- 1回の`send()`につき対象にできる`ingest_key`は1つです（複数センサーを送る場合は
  それぞれ別の`ingest_key`で`send()`を呼んでください）。
- 動作確認はPython 3.8〜で実施（Raspberry Pi OS Bookworm標準のPython 3.11でも動作想定）。

## ライセンス

MIT（`LICENSE`参照）。`docs/factoreye-architecture.md` §センサーデバイス対応に記載の
`raspberry-pi-rest-adapter`（公式プラグイン方針）に沿います。
