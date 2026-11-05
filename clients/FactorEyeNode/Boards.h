// 機種ごとの違い（ボタン・LED・Grove のピン・使える入出力ポート）。
// 新しい機種に対応するときは、ここに機種を 1 つ足す（ほかのファイルは変えない）。
//
// ポートの analog: アナログ入力できる（ADC1 のピン。ESP32 は WiFi を使っている間、ADC2 のピンを読めない）
// ポートの inputOnly: 入力専用のピン（出力にできない）
#pragma once
#include <Arduino.h>

struct PortInfo {
  const char* name;  // 画面と保存名に使う（例: "G19" → 保存名 g19_mode・g19_id）
  uint8_t pin;
  bool analog;
  bool inputOnly;
  const char* note;  // 画面に出す補足
};

struct BoardProfile {
  const char* name;
  const char* idPrefix;  // 書き込む ID の初期値の頭（例: "atom" → atom-b665-temp）
  const char* apPrefix;  // 設定モードのアクセスポイント名の頭（例: "M5-ATOMLite-Setup" → M5-ATOMLite-Setup-B665。20 バイトまで）
  int buttonPin;
  int ledPin;
  uint8_t sdaPin;  // Grove（ENV ユニットをつなぐ I2C）
  uint8_t sclPin;
  const PortInfo* ports;
  size_t portCount;
  int ledPowerPin;             // LED の電源ピン（NanoC6 は G19）。ない機種は -1
  unsigned long buttonWaitMs;  // 起動後にボタンを待つ時間。0 なら、起動の瞬間に押されているかを見る
  bool ledMono;                // LED が 1 色（点滅のしかたで状態を表す）
  bool ledActiveLow;           // 1 色の LED が、LOW で光る
  int powerHoldPin;            // 電池で動かすとき、電源を保つために HIGH にするピン（StickC Plus2 は G4）。ない機種は -1
  bool hasDisplay;             // 状態を出す画面がある（StatusScreen.cpp で表示する。LED のない機種の唯一の表示）
};

#if defined(ARDUINO_M5STACK_ATOM) || defined(ARDUINO_M5Stack_ATOM)

// ATOM Lite。ボタン G39・RGB LED G27・Grove（G26 = SDA, G32 = SCL）は、ここのポートには含めない（G39 だけ入力として使える）
static const PortInfo ATOM_LITE_PORTS[] = {
    {"G19", 19, false, false, "デジタルのみ"},
    {"G21", 21, false, false, "デジタルのみ"},
    {"G22", 22, false, false, "デジタルのみ"},
    {"G23", 23, false, false, "デジタルのみ"},
    {"G25", 25, false, false, "デジタルのみ（WiFi 中はアナログ不可）"},
    {"G33", 33, true, false, "デジタル・アナログ"},
    {"G39", 39, false, true, "本体ボタン（入力のみ）"},
};
static const BoardProfile BOARD = {"ATOM Lite", "atom", "M5-ATOMLite-Setup", 39, 27, 26, 32, ATOM_LITE_PORTS, sizeof(ATOM_LITE_PORTS) / sizeof(PortInfo), -1, 0, false, false, -1, false};

#elif defined(ARDUINO_M5STACK_ATOMS3) || defined(ARDUINO_M5Stack_ATOMS3)

// ATOMS3 Lite（ボードの選択は M5AtomS3）。Grove は M5 のサンプルに合わせた SDA G2 / SCL G1。実機で未確認。
// ESP32-S3 は G1〜G10 が ADC1 なので、G5〜G8 はアナログ入力できる
static const PortInfo ATOMS3_LITE_PORTS[] = {
    {"G5", 5, true, false, "デジタル・アナログ"},
    {"G6", 6, true, false, "デジタル・アナログ"},
    {"G7", 7, true, false, "デジタル・アナログ"},
    {"G8", 8, true, false, "デジタル・アナログ"},
};
static const BoardProfile BOARD = {"ATOMS3 Lite", "atoms3", "M5-ATOMS3Lite-Setup", 41, 35, 2, 1, ATOMS3_LITE_PORTS, sizeof(ATOMS3_LITE_PORTS) / sizeof(PortInfo), -1, 0, false, false, -1, false};

#elif defined(ARDUINO_M5STACK_NANOC6)

// NanoC6（ESP32-C6）。ボタン G9 は、起動のモード選びのピンと兼用: 押したまま電源を入れるとダウンロードモードに入ってしまう。
// そのため、起動してから 4 秒の間にボタンを押すと設定モードに入る（その間、LED が白く点滅）。
// RGB LED は G20。電源ピン G19 を HIGH にしてから使う。Grove（SDA G2 / SCL G1）以外に、外に出ているピンがないので、入出力ポートはない
// （G1・G2 は、ENV ユニットが使う）。
static const BoardProfile BOARD = {"NanoC6", "nanoc6", "M5-NanoC6-Setup", 9, 20, 2, 1, nullptr, 0, 19, 4000, false, false, -1, false};
#elif defined(ARDUINO_M5STACK_STICKC) || defined(ARDUINO_M5STACK_STICKC_PLUS) || defined(ARDUINO_M5STACK_STICKC_PLUS2)

// M5StickC / M5StickC Plus / M5StickC Plus2。ボタン A は G37（本体の正面）。赤い LED が 1 つだけ（RGB ではない）。
// ボタン A を押したまま電源を入れるのは難しい（電源は側面のボタンや USB）ので、起動後 3 秒の間に押す方式にする。
// Grove は SDA G32 / SCL G33。Hat の端子の G26（デジタル。ADC2 なので WiFi 中はアナログ不可）と G36（入力専用・アナログ可）を使える。
// 画面（160×80 など）と電源管理（AXP192）は使わない。
static const PortInfo STICKC_PORTS[] = {
    {"G26", 26, false, false, "デジタルのみ（Hat の端子。WiFi 中はアナログ不可）"},
    {"G36", 36, true, true, "入力のみ・アナログ可（Hat の端子）"},
};
#if defined(ARDUINO_M5STACK_STICKC_PLUS2)
// Plus2 の LED は G19（IR と共用）、電池で動かすときは G4 を HIGH にして電源を保つ。ピンは資料から取った値で、実機未確認
static const BoardProfile BOARD = {"M5StickC Plus2", "stickcplus2", "M5-StickCPlus2-Setup", 37, 19, 32, 33,
                                   STICKC_PORTS, sizeof(STICKC_PORTS) / sizeof(PortInfo), -1, 3000, true, false, 4, false};
#elif defined(ARDUINO_M5STACK_STICKC_PLUS)
static const BoardProfile BOARD = {"M5StickC Plus", "stickcplus", "M5-StickCPlus-Setup", 37, 10, 32, 33,
                                   STICKC_PORTS, sizeof(STICKC_PORTS) / sizeof(PortInfo), -1, 3000, true, true, -1, false};
#else
static const BoardProfile BOARD = {"M5StickC", "stickc", "M5-StickC-Setup", 37, 10, 32, 33,
                                   STICKC_PORTS, sizeof(STICKC_PORTS) / sizeof(PortInfo), -1, 3000, true, true, -1, false};
#endif

#elif defined(ARDUINO_M5STACK_CORE)

// M5Stack Basic（ESP32-D0WDQ6、320×240 の画面、ボタン A=G39・B=G38・C=G37）。LED はない。**状態は画面に出す**（StatusScreen.cpp）。
// ボタン A（G39、外付けのプルアップあり）を、起動後 3 秒の間に押すと設定モードに入る。
// Grove の Port A は SDA G21 / SCL G22（ENV ユニットをつなぐ）。Port B（G26・G36）と M-Bus の G35 を、入出力に使える。
// Port C（G16・G17）は、PSRAM つきの個体が使うので、ポートに含めない。
// フラッシュは 16MB だが、標準のパーティションの APP は 1.2MB で足りない（M5Unified の分が増える）。
// Arduino IDE の「Partition Scheme」を「No OTA (2MB APP/2MB SPIFFS)」にする（コマンドでは `:PartitionScheme=no_ota`）。
#define FACTOREYE_NODE_DISPLAY 1
static const PortInfo CORE_PORTS[] = {
    {"G26", 26, false, false, "Port B。デジタルのみ（WiFi 中はアナログ不可）"},
    {"G36", 36, true, true, "Port B。入力のみ・アナログ可"},
    {"G35", 35, true, true, "M-Bus。入力のみ・アナログ可"},
};
static const BoardProfile BOARD = {"M5Stack Basic", "core", "M5-Basic-Setup", 39, -1, 21, 22,
                                   CORE_PORTS, sizeof(CORE_PORTS) / sizeof(PortInfo), -1, 3000, false, false, -1, true};

#else
#error "この機種は未対応です。Boards.h に機種を足してください"
#endif
