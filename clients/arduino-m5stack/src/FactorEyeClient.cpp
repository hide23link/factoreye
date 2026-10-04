#include "FactorEyeClient.h"

#include <HTTPClient.h>
#include <WiFi.h>

// 初期値: バッファは空、失敗は0回、すぐ送ってよい（待ち時間なし）
FactorEyeClient::FactorEyeClient()
    : _bufferCount(0), _consecutiveFailures(0), _nextAttemptAtMs(0) {}

// 接続先と認証キーを設定する。送信の前に一度だけ呼ぶ。
void FactorEyeClient::begin(const String& host, const String& apiKey) {
  _host = host;
  _apiKey = apiKey;
  // ジッター用の乱数シード（暗号用途ではないのでmicros()で十分）
  randomSeed(micros());
}

// 未送信の件数（画面のデバッグ表示用）
size_t FactorEyeClient::pendingCount() const { return _bufferCount; }

// 値を送る。流れ: バックオフ中ならバッファへ入れて戻る。そうでなければ、同じセンサーの溜まった値と今回の値を
// まとめて1回の POST で送る。成功なら送った分をバッファから消す。失敗なら今回の値をバッファに残す。
bool FactorEyeClient::send(const String& ingestKey, float value) {
  unsigned long now = millis();
  // バックオフ期間中は通信を試みず、黙ってバッファに積んで即return
  // （millis()の桁あふれを跨いでも正しく動くよう符号付き差分で比較する）
  if ((long)(now - _nextAttemptAtMs) < 0) {
    _pushToBuffer(ingestKey, value);
    return false;
  }

  // 同じingestKeyで溜まっている分 + 今回の値 をまとめて1回のPOSTで送る
  float values[kBufferCapacity + 1];
  size_t count = 0;
  for (size_t i = 0; i < _bufferCount; i++) {
    if (_buffer[i].ingestKey == ingestKey) {
      values[count++] = _buffer[i].value;
    }
  }
  values[count++] = value;

  bool ok = _postReadings(ingestKey, values, count);
  _onSendResult(ok);

  if (ok) {
    _removeBufferedFor(ingestKey);
    return true;
  }

  _pushToBuffer(ingestKey, value);
  return false;
}

// バッファの末尾に1件追加する。満杯なら、一番古い1件を捨ててから追加する。
void FactorEyeClient::_pushToBuffer(const String& ingestKey, float value) {
  if (_bufferCount >= kBufferCapacity) {
    // 容量超過: 最古の1件を捨てて詰める（直近100件程度を保持するリングバッファ）
    for (size_t i = 1; i < _bufferCount; i++) {
      _buffer[i - 1] = _buffer[i];
    }
    _bufferCount--;
  }
  _buffer[_bufferCount].ingestKey = ingestKey;
  _buffer[_bufferCount].value = value;
  _bufferCount++;
}

// 指定したセンサーの未送信分を、バッファから消す（送信に成功したあとに使う）。残りの順序は保つ。
void FactorEyeClient::_removeBufferedFor(const String& ingestKey) {
  size_t writeIdx = 0;
  for (size_t readIdx = 0; readIdx < _bufferCount; readIdx++) {
    if (_buffer[readIdx].ingestKey != ingestKey) {
      _buffer[writeIdx++] = _buffer[readIdx];
    }
  }
  _bufferCount = writeIdx;
}

// 送信の結果に応じて、次に送ってよい時刻を決める。
// 成功: 失敗の回数と待ち時間をリセット。失敗: 待ち時間を 1, 2, 4, 8, 16, 30 秒と倍にし、±10% のゆらぎを付ける。
void FactorEyeClient::_onSendResult(bool success) {
  if (success) {
    _consecutiveFailures = 0;
    _nextAttemptAtMs = 0;
    return;
  }

  if (_consecutiveFailures < 255) {
    _consecutiveFailures++;
  }
  // 1s, 2s, 4s, 8s, 16s, 30s(上限)... docs/architecture.md §9 デバイス連携
  uint8_t shiftAmount = _consecutiveFailures - 1;
  if (shiftAmount > 5) shiftAmount = 5;
  unsigned long backoff = 1000UL << shiftAmount;
  if (backoff > kBackoffCapMs) backoff = kBackoffCapMs;

  // ±10% ジッター
  long jitterRange = (long)(backoff / 10);
  long jitter = jitterRange > 0 ? random(-jitterRange, jitterRange + 1) : 0;
  unsigned long delay = backoff + (unsigned long)jitter;

  _nextAttemptAtMs = millis() + delay;
}

// 値を、取り込み API へ1回だけ POST する。成功（202）なら true。
// WiFi につながっていない、または値が無いときは、通信せずに false を返す。
bool FactorEyeClient::_postReadings(const String& ingestKey, const float* values, size_t count) {
  if (WiFi.status() != WL_CONNECTED || count == 0) {
    return false;
  }

  // 本文の JSON を組み立てる（1件なら value、複数件なら readings の配列）
  String body;
  if (count == 1) {
    body = "{\"ingestKey\":\"" + ingestKey + "\",\"value\":" + String(values[0], 6) + "}";
  } else {
    body = "{\"ingestKey\":\"" + ingestKey + "\",\"readings\":[";
    for (size_t i = 0; i < count; i++) {
      if (i > 0) body += ",";
      body += "{\"value\":" + String(values[i], 6) + "}";
    }
    body += "]}";
  }

  HTTPClient http;
  http.begin(_host + "/api/ingest/readings");
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-API-Key", _apiKey);
  int httpCode = http.POST(body);
  http.end();

  // backend は成功時 202 Accepted を返す（app/api/ingest.py 参照）
  return httpCode == 202;
}
