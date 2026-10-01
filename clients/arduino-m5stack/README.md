# FactorEyeClient（M5Stack / ESP32 用 Arduinoライブラリ）

M5Stack Atom などのESP32系デバイスから、FactorEyeの[センサーIngest API](../../docs/factoreye-architecture.md)
(`POST /api/ingest/readings`) へ値を送るための最小クライアントです。
[Ambient](https://ambidata.io/)のライブラリと同じ感覚で、`begin()` と `send()` の2行で使えます。

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

1. このフォルダ（`clients/arduino-m5stack/`）ごと、Arduino IDEのライブラリフォルダ
   （通常 `~/Documents/Arduino/libraries/FactorEyeClient/`）にコピーまたはシンボリックリンク
2. Arduino IDEでボードを M5Stack Atom（または任意のESP32ボード）に設定
3. `File > Examples > FactorEyeClient > SendReading` を開き、WiFi/FactorEyeの接続情報を書き換えて書き込み

必要な追加ライブラリはありません（ESP32 Arduino core 同梱の `WiFi.h` / `HTTPClient.h` のみ使用）。

## 使い方

### 1. センサーを先に登録する

`send()` で使う `ingestKey` は、FactorEye側に事前に登録されているセンサーの `ingestKey` と
一致している必要があります（未登録のキーで送ると404になります）。FactorEyeの設定画面
（「設定」→「センサー」）、またはセットアップガイドから登録してください。

### 2. APIキー

`begin()` の第2引数は、backendの `.env` に設定した `INGEST_API_KEY` と同じ値を使います。
self-hosted運用ではインストールごとに1つの共有シークレットです（SaaS向けのワークスペース別
APIキーはPhase 0.5以降の対象で、本ライブラリは未対応）。

### 3. 送信の挙動（オフライン対応）

`send(ingestKey, value)` は以下のように動きます:

- 通常時: 即座に1回POSTし、成否（`true`/`false`）を返す
- 送信に失敗した場合: 値を内部のリングバッファ（最大100件）に保持し、次回以降の`send()`で
  まとめて再送を試みる。再送のタイミングは指数バックオフ（1秒→2秒→4秒→8秒→16秒→上限30秒、
  ±10%のジッター付き）に従う
- バックオフ待機中に呼ばれた`send()`は通信を試みず、値をバッファに積むだけで即座に返る
  （`loop()`をブロックしない）
- バッファが満杯のときは最も古い値から捨てられる

この挙動は `docs/factoreye-architecture.md` §Sensor Data Ingest の
「デバイス側リトライ（指数バックオフ）」の仕様に準拠しています。

`pendingCount()` で現在バッファに溜まっている未送信件数を取得できます（Serial出力等の
デバッグ用）。

### 制限事項（Phase 0）

- `ingestKey` に `"` や `\` などJSONエスケープが必要な文字を含めないでください（手書きJSON
  生成のため、エスケープ処理は行っていません）。センサー名は通常 `pressure-a1` のような
  単純な識別子にするため、実運用上は問題になりません。
- タイムスタンプは送信しません。FactorEyeバックエンドは受信時刻を採用し、デバイス側の
  時刻は信頼しない設計のためです（`docs/factoreye-architecture.md` 参照）。
- 1回の`send()`につき対象にできる`ingestKey`は1つです（複数センサーを送る場合はそれぞれ
  別の`ingestKey`で`send()`を呼んでください）。

## ライセンス

MIT（`LICENSE`参照）。`m5stack-rest-client` として
`docs/factoreye-architecture.md` §センサーデバイス対応 に記載の公式プラグイン方針に沿います。
