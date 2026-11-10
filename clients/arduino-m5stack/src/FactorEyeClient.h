// FactorEyeClient — M5Stack/ESP32からFactorEyeへセンサー値を送るための最小クライアント。
//
// Ambientライブラリと同じ使用感を狙う:
//   FactorEyeClient factoreye;
//   factoreye.begin("http://192.168.1.50:8000", "your-ingest-api-key");
//   factoreye.send("atom-temp-1", 25.3);
//
// 仕様の根拠: docs/architecture.md §9 デバイス連携
//   - 指数バックオフ: 1s, 2s, 4s, ... 上限30s（ジッター ±10%）
//   - 送信失敗分はリングバッファ（最大100件）に一時保持し、次回成功時にまとめて送信
//   - 再送するのは通信エラー・5xx・408・429（Retry-After が付いていれば尊重）。401・403・404 は設定の誤りなので
//     捨てずに保持して再送し続ける（保持は1センサー10件まで。全体のバックオフは延ばさない）。400・422 など再送しても成功しない 4xx は、その分を捨てる。
//     NaN・Infinity は送る前に捨てる
//
// 注意:
//   - FactorEyeのバックエンドは受信時刻を採用し、デバイス側のタイムスタンプは使わない
//     （docs参照）。そのため本ライブラリはタイムスタンプを送信しない。
//   - 1つの `send()` は即座に1回だけ送信を試み、失敗してもブロッキングのリトライは
//     行わない（M5Stackのloop()を止めないため）。バックオフ期間中の呼び出しは
//     リングバッファに積むだけで即座に返る。次にバックオフが明けたタイミングで
//     呼ばれたsend()が、溜まっている分をまとめて1回のPOSTで再送する。
#pragma once

#include <Arduino.h>

// M5Stack（ESP32）用の、FactorEye への送信クライアント。
// 状態（持っているもの）: 接続先・認証キー、未送信のリングバッファ（最大 100 件）、連続の失敗回数、次に送ってよい時刻。
// メモリを使う量は固定（動的なメモリ確保をほとんどしない）。M5Stack のメモリ不足を避けるため。
class FactorEyeClient {
 public:
  // 生成しただけでは通信しない。begin() で接続先を設定してから使う
  FactorEyeClient();

  // host: 例 "http://192.168.1.50:8000"（末尾スラッシュ不要）
  // apiKey: backend の .env に設定した INGEST_API_KEY と同じ値。空文字なら X-API-Key ヘッダーを付けずに送る
  //         （キーなしで取り込みを受け付けるサーバー向け。キーが必要なサーバーでは 401 になる）
  void begin(const String& host, const String& apiKey);

  // ingestKey に対応するセンサーへ value を送信する。
  // 1回の呼び出しで、送信を最大1回だけ試みる（失敗しても待たない。loop() を止めないため）。
  // 戻り値: 新しい値が（バッファ分も含め）実際に送信できた場合は true。
  //         WiFi未接続・バックオフ中・送信失敗の場合は false（内部でバッファに保持済み）。
  bool send(const String& ingestKey, float value);

  // 現在リングバッファに溜まっている未送信件数（Serial表示等のデバッグ用）。
  size_t pendingCount() const;

  // ingestKey に、センサーの名前と単位を結びつける（最大 20 個）。
  // backend が INGEST_AUTO_CREATE=on（self-hosted）のとき、未登録の ingestKey は、この名前・単位でセンサーが自動で作られる。
  // 名前と単位は、最初に送信が成功するまでの間だけ、本文に付ける（成功したら、登録済みなので付けない）。
  // 自動で作らない backend では、無視される（付けても、登録済みのセンサーは上書きされない）。
  void setSensorInfo(const String& ingestKey, const String& name, const String& unit);

 private:
  // 未送信の1件（どのセンサーの、どの値か）
  struct BufferedReading {
    String ingestKey;
    float value;
  };

  // 未送信の保存件数の上限（超えたら一番古いものから捨てる）
  static const size_t kBufferCapacity = 100;
  // 送信失敗が続いたときの待ち時間の上限（ミリ秒）
  static const unsigned long kBackoffCapMs = 30000;
  // 401・403・404（設定の誤り）で保持する、1センサーあたりの最大件数（超えたら古い値から捨てる）
  static const size_t kHoldPerKeyLimit = 10;

  // ingestKey ごとの、名前と単位（自動で作るときだけ使う）
  struct SensorInfo {
    String ingestKey;
    String name;
    String unit;
    bool confirmed;  // 送信が成功したか（成功したら、名前と単位は付けない）
  };
  // 20 個 = FactorEyeNode の最大 19 個（ENV 3 つ＋ポート 8 つ×パルスの個数・稼働の 2 つ）に、少し余裕を足した数
  static const size_t kSensorInfoCapacity = 20;

  String _host;
  String _apiKey;
  SensorInfo _sensorInfo[kSensorInfoCapacity];
  size_t _sensorInfoCount = 0;
  BufferedReading _buffer[kBufferCapacity];
  size_t _bufferCount;
  uint8_t _consecutiveFailures;
  unsigned long _nextAttemptAtMs;

  // 送信結果の分類（_postReadings の戻り値）
  enum SendOutcome { kOutcomeOk, kOutcomeRetry, kOutcomeHold, kOutcomeDrop };

  // 以下は内部の処理（外から直接は使わない）
  SensorInfo* _findSensorInfo(const String& ingestKey);
  void _pushToBuffer(const String& ingestKey, float value);
  void _removeBufferedFor(const String& ingestKey);
  void _trimBufferedFor(const String& ingestKey, size_t limit);
  void _onSendResult(bool success, unsigned long retryAfterMs);
  SendOutcome _postReadings(const String& ingestKey, const float* values, size_t count,
                            unsigned long* retryAfterMs);
};
