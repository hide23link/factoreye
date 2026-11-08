/* node_calc.h  FactorEyeNode の決まりと計算（ハードウェアに触らないので、PC で試験できる: test/host/run.sh）
 *  - 機種ごとのピンと、使える入出力ポート
 *  - 設定の保存名・選択肢・値の確かめ方
 *  - パルスを数える（割り込みから呼ぶ）・稼働／停止の判定
 *  新しい機種に対応するときは、下の「機種ごとのピン」に1つ足す
 */
#pragma once
#include <Arduino.h>

//****** 入出力ポート1つ分 ******
struct PORT_INFO {
  const char *name;    // 画面と保存名に使う（"G19" → 保存名 g19_mode・g19_id）
  uint8_t pin;
  bool analog;         // アナログ入力できる（ADC1 のピン。ESP32 は WiFi 中 ADC2 を読めない）
  bool input_only;     // 入力専用（出力・内部プルアップにできない）
  const char *note;    // 画面に出す補足
};

//****************************************************************
//  機種ごとのピン（ビルドのボード設定で決まる）
//  LED_MONO: LED が1色（点滅のしかたで状態を表す） / LED_LOW: その LED が LOW で光る
//  BTN_WAIT_MS: 起動後にボタンを待つ時間（0 = 起動の瞬間に押されているかを見る）
//  POWER_HOLD_PIN: 電池で動かすとき HIGH にして電源を保つピン / HAS_SCREEN: 状態を画面に出す
//****************************************************************
#if defined(ARDUINO_M5STACK_ATOM) || defined(ARDUINO_M5Stack_ATOM)
// ATOM Lite。Grove（G26・G32）と LED（G27）はポートにしない
#define BOARD_NAME      "ATOM Lite"
#define ID_PREFIX       "atom"                 // ID の初期値の頭（atom-b665-temp）
#define AP_NAME         "M5-ATOMLite-Setup"    // 設定モードの WiFi 名の頭（20バイトまで）
#define BTN_PIN         39
#define LED_PIN         27
#define I2C_SDA         26
#define I2C_SCL         32
#define LED_POWER_PIN   -1
#define BTN_WAIT_MS     0
#define LED_MONO        false
#define LED_LOW         false
#define POWER_HOLD_PIN  -1
#define HAS_SCREEN      0
static const PORT_INFO PORTS[] = {
    {"G19", 19, false, false, "デジタルのみ"},
    {"G21", 21, false, false, "デジタルのみ"},
    {"G22", 22, false, false, "デジタルのみ"},
    {"G23", 23, false, false, "デジタルのみ"},
    {"G25", 25, false, false, "デジタルのみ（WiFi 中はアナログ不可）"},
    {"G33", 33, true, false, "デジタル・アナログ"},
    {"G39", 39, false, true, "本体ボタン（入力のみ）"},
};
#define PORT_COUNT 7

#elif defined(ARDUINO_M5STACK_ATOMS3) || defined(ARDUINO_M5Stack_ATOMS3)
// ATOMS3 Lite（ボードは M5AtomS3）。Grove は M5 のサンプルに合わせた SDA G2 / SCL G1（実機未確認）
// ESP32-S3 は G1〜G10 が ADC1 なので、G5〜G8 はアナログ入力できる
#define BOARD_NAME      "ATOMS3 Lite"
#define ID_PREFIX       "atoms3"
#define AP_NAME         "M5-ATOMS3Lite-Setup"
#define BTN_PIN         41
#define LED_PIN         35
#define I2C_SDA         2
#define I2C_SCL         1
#define LED_POWER_PIN   -1
#define BTN_WAIT_MS     0
#define LED_MONO        false
#define LED_LOW         false
#define POWER_HOLD_PIN  -1
#define HAS_SCREEN      0
static const PORT_INFO PORTS[] = {
    {"G5", 5, true, false, "デジタル・アナログ"},
    {"G6", 6, true, false, "デジタル・アナログ"},
    {"G7", 7, true, false, "デジタル・アナログ"},
    {"G8", 8, true, false, "デジタル・アナログ"},
};
#define PORT_COUNT 4

#elif defined(ARDUINO_M5STACK_NANOC6)
// NanoC6（ESP32-C6）。ボタン G9 を押したまま電源を入れると書き込みモードになるので、起動後4秒の間に押す（LED が白く点滅）
// RGB LED は G20（G19 を HIGH にしてから使う）。外に出ているピンは Grove（ENV 用）だけなので、ポートはない
#define BOARD_NAME      "NanoC6"
#define ID_PREFIX       "nanoc6"
#define AP_NAME         "M5-NanoC6-Setup"
#define BTN_PIN         9
#define LED_PIN         20
#define I2C_SDA         2
#define I2C_SCL         1
#define LED_POWER_PIN   19
#define BTN_WAIT_MS     4000
#define LED_MONO        false
#define LED_LOW         false
#define POWER_HOLD_PIN  -1
#define HAS_SCREEN      0
static const PORT_INFO PORTS[] = {{"", 0, false, false, ""}};   // 使わない（C++ は 0 個の配列を作れないため1つ置く）
#define PORT_COUNT 0

#elif defined(ARDUINO_M5STACK_STICKC) || defined(ARDUINO_M5STACK_STICKC_PLUS) || defined(ARDUINO_M5STACK_STICKC_PLUS2)
// M5StickC / Plus / Plus2。ボタン A は G37（正面）。赤い LED が1つだけ。押したまま電源を入れにくいので、起動後3秒の間に押す
// Grove は SDA G32 / SCL G33。Hat の端子の G26・G36 を使える。画面と電源管理（AXP192）は使わない
#define BTN_PIN         37
#define I2C_SDA         32
#define I2C_SCL         33
#define LED_POWER_PIN   -1
#define BTN_WAIT_MS     3000
#define LED_MONO        true
#define HAS_SCREEN      0
static const PORT_INFO PORTS[] = {
    {"G26", 26, false, false, "デジタルのみ（Hat の端子。WiFi 中はアナログ不可）"},
    {"G36", 36, true, true, "入力のみ・アナログ可（Hat の端子）"},
};
#define PORT_COUNT 2
#if defined(ARDUINO_M5STACK_STICKC_PLUS2)
// Plus2 の LED は G19（IR と共用）。電池で動かすときは G4 を HIGH にして電源を保つ（資料から取った値で、実機未確認）
#define BOARD_NAME      "M5StickC Plus2"
#define ID_PREFIX       "stickcplus2"
#define AP_NAME         "M5-StickCPlus2-Setup"
#define LED_PIN         19
#define LED_LOW         false
#define POWER_HOLD_PIN  4
#elif defined(ARDUINO_M5STACK_STICKC_PLUS)
#define BOARD_NAME      "M5StickC Plus"
#define ID_PREFIX       "stickcplus"
#define AP_NAME         "M5-StickCPlus-Setup"
#define LED_PIN         10
#define LED_LOW         true
#define POWER_HOLD_PIN  -1
#else
#define BOARD_NAME      "M5StickC"
#define ID_PREFIX       "stickc"
#define AP_NAME         "M5-StickC-Setup"
#define LED_PIN         10
#define LED_LOW         true
#define POWER_HOLD_PIN  -1
#endif

#elif defined(ARDUINO_M5STACK_CORE)
// M5Stack Basic（320×240 の画面、ボタン A=G39）。LED がないので、状態は画面に出す
// ボタン A を起動後3秒の間に押すと設定モード。Grove Port A は SDA G21 / SCL G22
// Port B（G26・G36）と M-Bus の G35 を使える。Port C（G16・G17）は PSRAM つきの個体が使うので含めない
// 標準のパーティションでは入らないので「Partition Scheme」を「No OTA (2MB APP/2MB SPIFFS)」にする（:PartitionScheme=no_ota）
#define BOARD_NAME      "M5Stack Basic"
#define ID_PREFIX       "core"
#define AP_NAME         "M5-Basic-Setup"
#define BTN_PIN         39
#define LED_PIN         -1
#define I2C_SDA         21
#define I2C_SCL         22
#define LED_POWER_PIN   -1
#define BTN_WAIT_MS     3000
#define LED_MONO        false
#define LED_LOW         false
#define POWER_HOLD_PIN  -1
#define HAS_SCREEN      1
static const PORT_INFO PORTS[] = {
    {"G26", 26, false, false, "Port B。デジタルのみ（WiFi 中はアナログ不可）"},
    {"G36", 36, true, true, "Port B。入力のみ・アナログ可"},
    {"G35", 35, true, true, "M-Bus。入力のみ・アナログ可"},
};
#define PORT_COUNT 3

#else
#error "この機種は未対応です。node_calc.h の「機種ごとのピン」に機種を足してください"
#endif

//****************************************************************
//  設定の決まり
//  保存名: sensor・server・apikey・interval・id_temp・id_humi・id_press
//          ポートごとに <ポート名の小文字>_mode・_id・_lvl・_deb・_stop・_idrun（例: g19_mode）
//****************************************************************
// ポートの使い方（保存する値: off / din / dinpu / pulse / ain / dout）
#define PORT_OFF    0
#define PORT_DIN    1   // デジタル入力
#define PORT_DINPU  2   // デジタル入力（内部プルアップ）
#define PORT_PULSE  3   // パルスを数える（生産数）
#define PORT_AIN    4   // アナログ入力（電圧）
#define PORT_DOUT   5   // デジタル出力（使い方は今後追加）

// パルスを数えるポート
#define PULSE_WINDOW_MS      5000    // 個数を送る間隔（5秒。ENV の送る間隔とは別）
#define PULSE_DEB_DEFAULT    20      // デバウンスの初期値（ミリ秒）
#define PULSE_DEB_MAX        1000
#define PULSE_STOP_DEFAULT   60      // 停止とみなす秒数の初期値
#define PULSE_STOP_MAX       86400
#define PULSE_BUFFER_GUARD   60      // FactorEyeClient の溜め場（100件）がこれだけ埋まったら、個数を取り出さない

// 保存名。port_key("G19", "mode") → "g19_mode"（ESP32 の保存名は15文字まで）
inline String port_key(const char *port_name, const char *suffix) {
  String key = port_name;
  key.toLowerCase();
  return key + "_" + suffix;
}

inline int parse_port_mode(const String &value) {
  if (value == "din")   return PORT_DIN;
  if (value == "dinpu") return PORT_DINPU;
  if (value == "pulse") return PORT_PULSE;
  if (value == "ain")   return PORT_AIN;
  if (value == "dout")  return PORT_DOUT;
  return PORT_OFF;
}

// センサーが ON のときの電圧。"high" 以外は LOW（NPN・接点。初期値）
inline bool on_level_low(const String &value) { return value != "high"; }

// そのポートで選べる使い方。アナログは ADC1 のポートだけ、プルアップと出力は入力専用でないポートだけ
inline String port_options(const PORT_INFO &port) {
  String options = "off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）";
  if (!port.input_only) options += "|dinpu=デジタル入力（プルアップ）";
  if (port.analog)      options += "|ain=アナログ入力（電圧）";
  if (!port.input_only) options += "|dout=デジタル出力";
  return options;
}

// 送る間隔（ミリ秒）。保存が壊れていても 5秒〜1時間に収める
inline unsigned long interval_ms(long sec) {
  if (sec < 5) sec = 5;
  if (sec > 3600) sec = 3600;
  return (unsigned long)sec * 1000UL;
}

// ありえる値か（外れた値は、つながっていない・故障のサインなので送らない）
inline bool ok_temp(float t)  { return t >= -40.0f && t <= 125.0f; }
inline bool ok_hum(float h)   { return h >= 0.0f && h <= 100.0f; }
inline bool ok_press(float p) { return p >= 300.0f && p <= 1100.0f; }

// サーバーアドレスは http:// だけ（FactorEyeClient は https に対応していない）
inline bool http_address(const String &address) { return address.startsWith("http://") && address.length() > 7; }

// 前後の空白と末尾の / を取る（残すと http://x:8000//api/… になり 404）
inline String clean_address(const String &address) {
  String s = address;
  s.trim();
  while (s.length() > 0 && s[s.length() - 1] == '/') s.remove(s.length() - 1);
  return s;
}

// Sensirion（SHT30・SHT40）の CRC（多項式 0x31、初期値 0xFF）
inline uint8_t sht_crc(const uint8_t *data, int len) {
  uint8_t crc = 0xFF;
  for (int i = 0; i < len; i++) {
    crc ^= data[i];
    for (int bit = 0; bit < 8; bit++) crc = (crc & 0x80) ? (uint8_t)((crc << 1) ^ 0x31) : (uint8_t)(crc << 1);
  }
  return crc;
}

// シリアル番号の応答（2バイト + CRC を2組 = 6バイト）が正しいか
inline bool sht_serial_ok(const uint8_t *b) {
  return sht_crc(b, 2) == b[2] && sht_crc(b + 3, 2) == b[5];
}

//****** 送り先（ID）ごとの、最後に送れた時刻。1つの ID だけ送れない（未登録で404など）ことも見つける ******
struct SEND_TARGET {
  String id;
  unsigned long ok_ms = 0;
};

inline bool any_stalled(const SEND_TARGET *targets, int count, unsigned long now_ms, unsigned long limit_ms) {
  for (int i = 0; i < count; i++) {
    if (now_ms - targets[i].ok_ms > limit_ms) return true;
  }
  return false;
}

// 異常とみなすまでの時間（間隔の3倍。ただし2分以上）
inline unsigned long fail_limit_ms(unsigned long interval) {
  unsigned long limit = interval * 3;
  if (limit < 120000UL) return 120000UL;
  return limit;
}

//****************************************************************
//  パルスを数える（割り込みから pulse_edge を呼ぶ）
//  数えるのは割り込みなので、loop() が通信で数秒止まっても数え続ける
//  時刻の差は符号なしの引き算（micros() は約71分、millis() は約49日で0に戻っても、差は正しい）
//****************************************************************
#if defined(ESP_PLATFORM)
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
// 割り込みと loop が、同じ変数を同時に触らないようにする
static portMUX_TYPE pulse_mux = portMUX_INITIALIZER_UNLOCKED;
#define PULSE_LOCK_ISR()    portENTER_CRITICAL_ISR(&pulse_mux)
#define PULSE_UNLOCK_ISR()  portEXIT_CRITICAL_ISR(&pulse_mux)
#define PULSE_LOCK()        portENTER_CRITICAL(&pulse_mux)
#define PULSE_UNLOCK()      portEXIT_CRITICAL(&pulse_mux)
#else
#ifndef IRAM_ATTR
#define IRAM_ATTR
#endif
#define PULSE_LOCK_ISR()
#define PULSE_UNLOCK_ISR()
#define PULSE_LOCK()
#define PULSE_UNLOCK()
#endif

struct PULSE {
  uint32_t deb_us;                 // 1つ数えてから、この時間（μ秒）の信号は数えない（チャタリング）
  volatile uint32_t count;         // 数えた個数（取り出すと0に戻る）
  volatile uint32_t total;         // 起動してからの合計（確認用）
  volatile bool counted;           // まだ1つも数えていなければ false
  volatile uint32_t last_us;       // 最後に数えた時刻（デバウンス用）
  volatile uint32_t last_ms;       // 最後に数えた時刻（停止の判定用）
};

// start_ms: 起動した時刻。最初のパルスまでは、これを「最後のパルス」とみなす（再起動の直後に「停止」を出さない）
inline void pulse_begin(PULSE *p, uint32_t deb_us, uint32_t start_ms) {
  p->deb_us = deb_us;
  p->count = 0;
  p->total = 0;
  p->counted = false;
  p->last_us = 0;
  p->last_ms = start_ms;
}

// 割り込みから呼ぶ（Serial・String・HTTP は使わない）
inline void IRAM_ATTR pulse_edge(PULSE *p, uint32_t now_us, uint32_t now_ms) {
  PULSE_LOCK_ISR();
  if (!p->counted || (uint32_t)(now_us - p->last_us) >= p->deb_us) {
    p->counted = true;
    p->last_us = now_us;
    p->last_ms = now_ms;
    p->count++;
    p->total++;
  }
  PULSE_UNLOCK_ISR();
}

// 数えた個数を取り出して0に戻す（読むのと戻すのを1まとまりで）
inline uint32_t pulse_take(PULSE *p) {
  PULSE_LOCK();
  uint32_t n = p->count;
  p->count = 0;
  PULSE_UNLOCK();
  return n;
}

inline uint32_t pulse_last_ms(PULSE *p) {
  PULSE_LOCK();
  uint32_t ms = p->last_ms;
  PULSE_UNLOCK();
  return ms;
}

//****************************************************************
//  稼働／停止の判定
//  時間: 最後のパルスから stop_ms 以内なら稼働（ちょうど stop_ms も稼働）
//  外部の信号（将来）: RUN_ON・RUN_OFF なら時間より優先する。いまは入れる場所がなく、常に RUN_UNKNOWN
//****************************************************************
#define RUN_UNKNOWN  0
#define RUN_ON       1
#define RUN_OFF      2

inline bool run_by_time(uint32_t last_ms, uint32_t now_ms, uint32_t stop_ms) {
  return (uint32_t)(now_ms - last_ms) <= stop_ms;
}

inline bool is_running(bool by_time, int external) {
  if (external == RUN_ON)  return true;
  if (external == RUN_OFF) return false;
  return by_time;
}
