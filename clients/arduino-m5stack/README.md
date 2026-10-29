# FactorEyeClient（M5Stack / ESP32 用 Arduino ライブラリ）

M5Stack Atom などの ESP32 系デバイスから、FactorEye の[センサー Ingest API](../../docs/architecture.md)（`POST /api/ingest/readings`）へ値を送るための最小クライアントです。`begin()` と `send()` の 2 行で使えます。

```cpp
#include <FactorEyeClient.h>

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

## インストール

1. このフォルダごと、Arduino IDE のライブラリフォルダ（通常 `~/Documents/Arduino/libraries/FactorEyeClient/`）にコピーまたはシンボリックリンクする
2. ボードを M5Stack Atom（または任意の ESP32 ボード）に設定する
3. `File > Examples > FactorEyeClient > SendReading` を開き、WiFi と FactorEye の接続情報を書き換えて書き込む

追加のライブラリは不要です（ESP32 Arduino core 同梱の `WiFi.h` / `HTTPClient.h` のみ）。

## 使い方

### 1. センサーを先に登録する

`send()` の `ingestKey` は、FactorEye に登録済みのセンサーの `ingestKey` と一致している必要があります（未登録なら 404）。画面の「設定」→「センサー」、またはセットアップガイドから登録してください。自動登録（`INGEST_AUTO_CREATE=on`、self-hosted のみ）を使う場合は不要です。

### 2. APIキー

`begin()` の第 2 引数は、backend の `INGEST_API_KEY` と同じ値です。backend を `INGEST_AUTH=off` で動かしているときは空文字（`""`）を渡します（そのときは `X-API-Key` を付けずに送ります）。SaaS 版へ送る場合、キーは見られないので任意の文字列で構いません（センサーは本文の `ingestKey` で識別されます）。

### 自動登録（任意）

`INGEST_AUTO_CREATE=on` の backend では、画面で登録しなくても送り始められます。名前と単位を `setSensorInfo` で結びつけます。

```cpp
factoreye.begin("http://192.168.1.50:8000", "");
factoreye.setSensorInfo("atom-temp-1", "ATOM 温度", "℃");  // 未登録なら、この名前・単位で作られる
factoreye.send("atom-temp-1", 25.3);
```

名前と単位は、最初に送信が成功するまでの間だけ本文に付きます（最大 16 個まで結びつけられます）。

### 3. 送信の挙動

- `send(ingestKey, value)` は、通常は即座に 1 回 POST し、成否（`true` / `false`）を返します
- 送れなかった値はリングバッファ（最大 100 件）に保持し、次回以降の `send()` でまとめて再送します。待機は指数バックオフ（上限 30 秒）で、待機中の `send()` は通信せずに積むだけで戻るため、`loop()` をブロックしません
- 再送の対象、保持の上限、捨てる条件は、[`docs/architecture.md`](../../docs/architecture.md) §9 の「送信失敗時の再送（デバイス側）」に従います
- `pendingCount()` で、バッファに溜まっている未送信件数を取得できます（デバッグ用）

### 制限事項

- `ingestKey` に `"` や `\` など JSON のエスケープが必要な文字を入れないでください（手書きの JSON のため、エスケープ処理はしていません）
- タイムスタンプは送りません。backend は受信時刻を採用します（デバイスの時刻は信頼しない設計）
- 1 回の `send()` で対象にできる `ingestKey` は 1 つです

## ライセンス

MIT（`LICENSE` 参照）。
