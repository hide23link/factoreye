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

// ingestKey に、名前と単位を結びつける。同じ ingestKey を呼び直したら、上書きする。
void FactorEyeClient::setSensorInfo(const String& ingestKey, const String& name, const String& unit) {
  SensorInfo* info = _findSensorInfo(ingestKey);
  if (info == nullptr) {
    if (_sensorInfoCount >= kSensorInfoCapacity) return;  // 上限（20 個）を超えた分は、名前を付けずに送る
    info = &_sensorInfo[_sensorInfoCount++];
    info->ingestKey = ingestKey;
  }
  info->name = name;
  info->unit = unit;
  info->confirmed = false;
}

FactorEyeClient::SensorInfo* FactorEyeClient::_findSensorInfo(const String& ingestKey) {
  for (size_t i = 0; i < _sensorInfoCount; i++) {
    if (_sensorInfo[i].ingestKey == ingestKey) return &_sensorInfo[i];
  }
  return nullptr;
}

// JSON の文字列に入れられるよう、" と \ と制御文字を直す（名前・単位は、人が決めた文字なので）
static String escapeJson(const String& text) {
  String result;
  for (size_t i = 0; i < text.length(); i++) {
    char c = text[i];
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if ((uint8_t)c < 0x20) {
      result += ' ';
    } else {
      result += c;  // UTF-8 の日本語は、そのまま通す
    }
  }
  return result;
}

// 値を送る。流れ: バックオフ中ならバッファへ入れて戻る。そうでなければ、同じセンサーの溜まった値と今回の値を
// まとめて1回の POST で送る。成功なら送った分をバッファから消す。失敗なら今回の値をバッファに残す。
bool FactorEyeClient::send(const String& ingestKey, float value) {
  // NaN・Infinity は backend が 400 で拒否する値。バッファに入れると同じセンサーの以降のバッチが
  // すべて拒否されるため、送る前に捨てる
  if (isnan(value) || isinf(value)) {
    Serial.println("[FactorEye] non-finite value dropped: " + ingestKey);
    return false;
  }

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

  unsigned long retryAfterMs = 0;
  SendOutcome outcome = _postReadings(ingestKey, values, count, &retryAfterMs);

  if (outcome == kOutcomeOk) {
    SensorInfo* info = _findSensorInfo(ingestKey);
    if (info != nullptr) info->confirmed = true;  // 登録できたので、以後は名前と単位を付けない
  }
  if (outcome == kOutcomeOk || outcome == kOutcomeDrop) {
    if (outcome == kOutcomeDrop) {
      // 再送しても成功しない内容（400・422 など）。溜まっていた分も同じバッチなので、まとめて捨てる
      Serial.println("[FactorEye] rejected by server, dropped " + String((unsigned long)count) +
                     " reading(s): " + ingestKey);
    }
    // サーバーとは通信できているので、バックオフは解除する
    _onSendResult(true, 0);
    _removeBufferedFor(ingestKey);
    return outcome == kOutcomeOk;
  }

  if (outcome == kOutcomeHold) {
    // 401・403・404: 設定の誤り。データは捨てずに保持するが、このセンサーだけの問題なので、
    // クライアント全体のバックオフは延ばさず、保持はセンサーごとの上限までにする
    // （他のセンサーの未送信値を押し出さないため）
    Serial.println("[FactorEye] check API key / ingestKey (data kept, max 10): " + ingestKey);
    _pushToBuffer(ingestKey, value);
    _trimBufferedFor(ingestKey, kHoldPerKeyLimit);
    return false;
  }
  _onSendResult(false, retryAfterMs);
  _pushToBuffer(ingestKey, value);
  return false;
}

// 指定したセンサーの未送信が limit 件を超えていたら、古いものから捨てる（他のセンサーは触らない）。
void FactorEyeClient::_trimBufferedFor(const String& ingestKey, size_t limit) {
  size_t total = 0;
  for (size_t i = 0; i < _bufferCount; i++) {
    if (_buffer[i].ingestKey == ingestKey) total++;
  }
  size_t excess = total > limit ? total - limit : 0;
  size_t writeIdx = 0;
  for (size_t readIdx = 0; readIdx < _bufferCount; readIdx++) {
    if (excess > 0 && _buffer[readIdx].ingestKey == ingestKey) {
      excess--;
      continue;
    }
    _buffer[writeIdx++] = _buffer[readIdx];
  }
  _bufferCount = writeIdx;
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
void FactorEyeClient::_onSendResult(bool success, unsigned long retryAfterMs) {
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
  // 429 の Retry-After があれば、それより早くは送らない
  if (retryAfterMs > delay) delay = retryAfterMs;

  _nextAttemptAtMs = millis() + delay;
}

// 値を、取り込み API へ1回だけ POST し、結果を分類して返す。
//   kOutcomeOk:    202 Accepted
//   kOutcomeRetry: 通信エラー・WiFi未接続・5xx・408・429（バッファに残して、バックオフ後に再送）
//   kOutcomeHold:  401・403・404（設定の誤り。データは捨てず再送し続ける）
//   kOutcomeDrop:  400・422 などの 4xx（同じ内容を送り直しても成功しない。その分を捨てる）
// 429 の Retry-After（秒）があれば、*retryAfterMs に待ち時間（ミリ秒、上限5分）を入れる。
FactorEyeClient::SendOutcome FactorEyeClient::_postReadings(const String& ingestKey,
                                                           const float* values, size_t count,
                                                           unsigned long* retryAfterMs) {
  *retryAfterMs = 0;
  if (WiFi.status() != WL_CONNECTED || count == 0) {
    return kOutcomeRetry;
  }

  // 自動で作るときの、名前と単位（結びつけてあって、まだ送信が成功していないときだけ付ける）
  String extra;
  SensorInfo* info = _findSensorInfo(ingestKey);
  if (info != nullptr && !info->confirmed) {
    extra = ",\"name\":\"" + escapeJson(info->name) + "\",\"unit\":\"" + escapeJson(info->unit) + "\"";
  }

  // 本文の JSON を組み立てる（1件なら value、複数件なら readings の配列）
  String body;
  if (count == 1) {
    body = "{\"ingestKey\":\"" + ingestKey + "\"" + extra + ",\"value\":" + String(values[0], 6) + "}";
  } else {
    body = "{\"ingestKey\":\"" + ingestKey + "\"" + extra + ",\"readings\":[";
    for (size_t i = 0; i < count; i++) {
      if (i > 0) body += ",";
      body += "{\"value\":" + String(values[i], 6) + "}";
    }
    body += "]}";
  }

  HTTPClient http;
  http.begin(_host + "/api/ingest/readings");
  http.addHeader("Content-Type", "application/json");
  if (!_apiKey.isEmpty()) http.addHeader("X-API-Key", _apiKey);  // キーなしで受け付けるサーバー向け（空なら送らない）
  // 応答ヘッダーのうち Retry-After だけ読めるようにする（POST の前に指定する）
  const char* headerKeys[] = {"Retry-After"};
  http.collectHeaders(headerKeys, 1);
  int httpCode = http.POST(body);
  String retryAfter = (httpCode > 0) ? http.header("Retry-After") : String("");
  http.end();

  // backend は成功時 202 Accepted を返す（app/api/ingest.py 参照）
  if (httpCode == 202) return kOutcomeOk;
  if (httpCode == 401 || httpCode == 403 || httpCode == 404) return kOutcomeHold;
  if (httpCode == 429) {
    long seconds = retryAfter.toInt();  // 数字でなければ 0（日付形式は扱わない）
    if (seconds > 0) {
      if (seconds > 300) seconds = 300;
      *retryAfterMs = (unsigned long)seconds * 1000UL;
    }
    return kOutcomeRetry;
  }
  if (httpCode >= 400 && httpCode < 500 && httpCode != 408) return kOutcomeDrop;
  // 負の値（通信エラー・タイムアウト）、5xx、408、その他の想定外はデータを失わない側に倒す
  return kOutcomeRetry;
}
