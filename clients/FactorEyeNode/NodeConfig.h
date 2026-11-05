// 設定の決まり（保存名・選択肢・値の読み方）。ハードウェアに触らない部分だけをここにまとめ、PC 上でテストできるようにしている。
//
// 設定画面の項目（WifiStarter に登録する）:
//   sensor        つないでいるユニット: none / ENV3 / ENV4 / ENV2
//   server        サーバーアドレス（FactorEye。http:// で始める）
//   apikey        API キー（FactorEye の INGEST_API_KEY）
//   interval      送る間隔（秒）
//   id_temp / id_humi / id_press   温度・湿度・気圧の書き込む ID
//   <ポート名の小文字>_mode  off / din / dinpu / ain / dout（例: g19_mode）
//   <ポート名の小文字>_id    入力の書き込む ID（例: g19_id）
#pragma once
#include <Arduino.h>

#include "Boards.h"

enum class PortMode { Off, DigitalIn, DigitalInPullup, Pulse, AnalogIn, DigitalOut };

// パルスを数えるポート（生産数）の決まり
const unsigned long PULSE_WINDOW_MS = 5000;     // 個数を送る間隔（5 秒）。ENV の送る間隔とは、別
const long PULSE_DEBOUNCE_DEFAULT_MS = 20;      // デバウンスの初期値（ミリ秒）
const long PULSE_DEBOUNCE_MAX_MS = 1000;
const long PULSE_STOP_DEFAULT_SECONDS = 60;     // 停止とみなす秒数の初期値
const long PULSE_STOP_MAX_SECONDS = 86400;
// FactorEyeClient の溜め場（100 件）が、これだけ埋まっていたら、個数を取り出さない（カウンタに残して、あとで合計で送る）
const size_t PULSE_SEND_BUFFER_GUARD = 60;

// 保存名。例: portKey("G19", "mode") → "g19_mode"（ESP32 の保存名は 15 文字まで）
inline String portKey(const char* portName, const char* suffix) {
  String key = portName;
  key.toLowerCase();
  return key + "_" + suffix;
}

inline PortMode parsePortMode(const String& value) {
  if (value == "din") return PortMode::DigitalIn;
  if (value == "dinpu") return PortMode::DigitalInPullup;
  if (value == "pulse") return PortMode::Pulse;
  if (value == "ain") return PortMode::AnalogIn;
  if (value == "dout") return PortMode::DigitalOut;
  return PortMode::Off;
}

// センサーが ON のときの電圧。"high" 以外は、LOW（NPN・接点）として扱う（初期値）
inline bool isOnLevelLow(const String& value) { return value != "high"; }

// そのポートで選べる使い方。アナログ入力は ADC1 のポートだけ、プルアップと出力は入力専用でないポートだけ
inline String portModeOptions(const PortInfo& port) {
  String options = "off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）";
  if (!port.inputOnly) options += "|dinpu=デジタル入力（プルアップ）";
  if (port.analog) options += "|ain=アナログ入力（電圧）";
  if (!port.inputOnly) options += "|dout=デジタル出力";
  return options;
}

// Sensirion のセンサー（SHT30・SHT40）の通信で使う CRC（多項式 0x31、初期値 0xFF）。データ 2 バイトに 1 バイトの CRC が付く
inline uint8_t sensirionCrc8(const uint8_t* data, size_t length) {
  uint8_t crc = 0xFF;
  for (size_t i = 0; i < length; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

// シリアル番号の応答（2 バイト + CRC を 2 組 = 6 バイト）が正しいか
inline bool isValidSensirionSerial(const uint8_t* bytes) {
  return sensirionCrc8(bytes, 2) == bytes[2] && sensirionCrc8(bytes + 3, 2) == bytes[5];
}

// 送る間隔（ミリ秒）。画面の選択肢以外の値（保存が壊れたなど）でも、5 秒〜1 時間に収める
inline unsigned long intervalMs(long seconds) {
  if (seconds < 5) seconds = 5;
  if (seconds > 3600) seconds = 3600;
  return (unsigned long)seconds * 1000UL;
}

// センサーの値が、ありえる範囲か（外れた値は、つながっていない・故障のサインなので送らない）
inline bool isSaneTemperature(float celsius) { return celsius >= -40.0f && celsius <= 125.0f; }
inline bool isSaneHumidity(float percent) { return percent >= 0.0f && percent <= 100.0f; }
inline bool isSanePressure(float hectopascal) { return hectopascal >= 300.0f && hectopascal <= 1100.0f; }

// サーバーアドレスの書き方の確認。FactorEyeClient は https に対応していないため、http:// だけ受け付ける
inline bool isHttpAddress(const String& address) { return address.startsWith("http://") && address.length() > 7; }

// 末尾の / を取る（残すと「http://x:8000//api/…」になり、404 で送れない）
inline String normalizeServerAddress(const String& address) {
  String result = address;
  result.trim();
  while (result.length() > 0 && result[result.length() - 1] == '/') result.remove(result.length() - 1);
  return result;
}

// 送り先（書き込む ID）1 つ分。最後に送れた時刻を覚えておき、1 つの ID だけ送れていない（未登録で 404 など）ことも見つける
struct SendTarget {
  String ingestId;
  unsigned long lastSuccessMs = 0;
};

inline bool anyTargetStalled(const SendTarget* targets, size_t count, unsigned long nowMs, unsigned long limitMs) {
  for (size_t i = 0; i < count; i++) {
    if (nowMs - targets[i].lastSuccessMs > limitMs) return true;
  }
  return false;
}

// 最後に送れた時刻から、異常と見なすまでの時間（間隔の 3 倍。ただし 2 分以上）
inline unsigned long sendFailureLimitMs(unsigned long intervalMillis) {
  unsigned long limit = intervalMillis * 3;
  return limit < 120000UL ? 120000UL : limit;
}
