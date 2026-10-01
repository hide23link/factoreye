#include "FactorEyeClient.h"

#include <HTTPClient.h>
#include <WiFi.h>

FactorEyeClient::FactorEyeClient()
    : _bufferCount(0), _consecutiveFailures(0), _nextAttemptAtMs(0) {}

void FactorEyeClient::begin(const String& host, const String& apiKey) {
  _host = host;
  _apiKey = apiKey;
  // ジッター用の乱数シード（暗号用途ではないのでmicros()で十分）
  randomSeed(micros());
}

size_t FactorEyeClient::pendingCount() const { return _bufferCount; }

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

void FactorEyeClient::_removeBufferedFor(const String& ingestKey) {
  size_t writeIdx = 0;
  for (size_t readIdx = 0; readIdx < _bufferCount; readIdx++) {
    if (_buffer[readIdx].ingestKey != ingestKey) {
      _buffer[writeIdx++] = _buffer[readIdx];
    }
  }
  _bufferCount = writeIdx;
}

void FactorEyeClient::_onSendResult(bool success) {
  if (success) {
    _consecutiveFailures = 0;
    _nextAttemptAtMs = 0;
    return;
  }

  if (_consecutiveFailures < 255) {
    _consecutiveFailures++;
  }
  // 1s, 2s, 4s, 8s, 16s, 30s(上限)... docs/factoreye-architecture.md §デバイス側リトライ
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

bool FactorEyeClient::_postReadings(const String& ingestKey, const float* values, size_t count) {
  if (WiFi.status() != WL_CONNECTED || count == 0) {
    return false;
  }

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
