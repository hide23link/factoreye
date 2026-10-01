// FactorEyeClient — M5Stack/ESP32からFactorEyeへセンサー値を送るための最小クライアント。
//
// Ambientライブラリと同じ使用感を狙う:
//   FactorEyeClient factoreye;
//   factoreye.begin("http://192.168.1.50:8000", "your-ingest-api-key");
//   factoreye.send("atom-temp-1", 25.3);
//
// 仕様の根拠: docs/factoreye-architecture.md §Sensor Data Ingest（デバイス側リトライ）
//   - 指数バックオフ: 1s, 2s, 4s, ... 上限30s（ジッター ±10%）
//   - 送信失敗分はリングバッファ（最大100件）に一時保持し、次回成功時にまとめて送信
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

class FactorEyeClient {
 public:
  FactorEyeClient();

  // host: 例 "http://192.168.1.50:8000"（末尾スラッシュ不要）
  // apiKey: backend の .env に設定した INGEST_API_KEY と同じ値
  void begin(const String& host, const String& apiKey);

  // ingestKey に対応するセンサーへ value を送信する。
  // 戻り値: 新しい値が（バッファ分も含め）実際に送信できた場合は true。
  //         WiFi未接続・バックオフ中・送信失敗の場合は false（内部でバッファに保持済み）。
  bool send(const String& ingestKey, float value);

  // 現在リングバッファに溜まっている未送信件数（Serial表示等のデバッグ用）。
  size_t pendingCount() const;

 private:
  struct BufferedReading {
    String ingestKey;
    float value;
  };

  static const size_t kBufferCapacity = 100;
  static const unsigned long kBackoffCapMs = 30000;

  String _host;
  String _apiKey;
  BufferedReading _buffer[kBufferCapacity];
  size_t _bufferCount;
  uint8_t _consecutiveFailures;
  unsigned long _nextAttemptAtMs;

  void _pushToBuffer(const String& ingestKey, float value);
  void _removeBufferedFor(const String& ingestKey);
  void _onSendResult(bool success);
  bool _postReadings(const String& ingestKey, const float* values, size_t count);
};
