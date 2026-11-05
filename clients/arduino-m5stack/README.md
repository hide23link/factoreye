# FactorEyeClient（M5Stack / ESP32 用 Arduino ライブラリ）

M5Stack Atom などの ESP32 から、FactorEye へ値を送る最小クライアントです。
[Ambient](https://ambidata.io/) のライブラリと同じ感覚で、`begin()` と `send()` の 2 行で使えます。

```cpp
#include <WiFi.h>
#include <FactorEyeClient.h>

const char* ssid = "your-ssid";
const char* password = "your-password";
FactorEyeClient factoreye;

void setup() {
  WiFi.begin(ssid, password);
  while (WiFi.status() != WL_CONNECTED) delay(500);

  factoreye.begin("http://192.168.1.50:8000", "your-ingest-api-key");
}

void loop() {
  factoreye.send("atom-temp-1", 25.3);
  delay(10000);
}
```

> 温度・湿度・気圧やパルスを、スマホの設定画面だけで送りたいときは、そのまま使えるスケッチ [`FactorEyeNode`](../FactorEyeNode/) を使ってください。

## インストール

1. このフォルダを `FactorEyeClient` という名前で、Arduino のライブラリフォルダ（`~/Documents/Arduino/libraries/`）にコピーする
2. Arduino IDE で、ボードを M5Stack Atom（または任意の ESP32）に設定する
3. 「ファイル → スケッチ例 → FactorEyeClient → SendReading」を開き、WiFi と FactorEye の接続情報を書き換えて書き込む

追加のライブラリは要りません（ESP32 Arduino core 同梱の `WiFi.h` / `HTTPClient.h` だけを使います）。

## 使い方

- **センサーを先に登録する**
  - `send()` の `ingestKey` は、FactorEye に登録済みのセンサーのキーと一致させる
  - 未登録だと 404 になる。「設定 → センサー」か、セットアップガイドで登録する
- **API キー**（`begin()` の第 2 引数）
  - self-hosted: backend の `INGEST_API_KEY` と同じ値
  - `INGEST_AUTH=off` のとき: 空文字（`""`）。`X-API-Key` ヘッダーは付かない
  - SaaS: ヘッダーは見られないので、任意の文字列でよい
- **センサーの自動登録**（backend が `INGEST_AUTO_CREATE=on` のとき）
  - 画面で登録しなくても、送り始められる
  - 名前と単位は `setSensorInfo` で結びつける（最大 16 個。最初の送信が成功するまで本文に付く）

  ```cpp
  factoreye.setSensorInfo("atom-temp-1", "ATOM 温度", "℃");
  factoreye.send("atom-temp-1", 25.3);
  ```

## 送信の挙動

- 通常は、即座に 1 回 POST して、成否（`true` / `false`）を返す
- 失敗した値は、最大 100 件のリングバッファに保持し、次の `send()` でまとめて再送する
  - 待ち時間は 1・2・4・8・16 秒、上限 30 秒（±10% のジッター）
  - 待機中の `send()` は、通信せずに値を積むだけで即座に返る（`loop()` を止めない）
  - バッファが満杯なら、古い値から捨てる
- 失敗の種類による扱いは [`docs/architecture.md`](../../docs/architecture.md) §9 のとおり
- `pendingCount()` で、未送信の件数を取得できる

## 制限

- **http のみ**（https は未対応）
- `ingestKey` には、`"` や `\` など JSON のエスケープが必要な文字を含めない
- タイムスタンプは送らない（FactorEye は受信時刻を採用する）
- 1 回の `send()` で送れる `ingestKey` は 1 つ

## ライセンス

MIT（[LICENSE](LICENSE)）。
