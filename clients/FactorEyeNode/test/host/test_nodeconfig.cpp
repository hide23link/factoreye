// FactorEyeNode の設定の決まり（NodeConfig.h・Boards.h）を PC 上で確かめる。実行: ./run.sh
// Arduino の偽物は fakes/ にある。
// run.sh が、機種ごとに -DARDUINO_M5STACK_ATOM などを付けて、3 回コンパイルして実行する
#if !defined(ARDUINO_M5STACK_ATOM) && !defined(ARDUINO_M5STACK_ATOMS3) && !defined(ARDUINO_M5STACK_NANOC6) && \
    !defined(ARDUINO_M5STACK_STICKC) && !defined(ARDUINO_M5STACK_STICKC_PLUS) && !defined(ARDUINO_M5STACK_STICKC_PLUS2) && \
    !defined(ARDUINO_M5STACK_CORE)
#define ARDUINO_M5STACK_ATOM 1
#endif
#include <cstdio>
#include <cstring>

#include "NodeConfig.h"

static int failures = 0;
static int checks = 0;
#define CHECK(condition)                                               \
  do {                                                                 \
    checks++;                                                          \
    if (!(condition)) {                                                \
      failures++;                                                      \
      std::printf("  NG %s:%d  %s\n", __FILE__, __LINE__, #condition); \
    }                                                                  \
  } while (0)

int main() {
  // 保存名は 15 文字まで（ESP32 の保存領域の決まり）
  for (size_t i = 0; i < BOARD.portCount; i++) {
    CHECK(portKey(BOARD.ports[i].name, "mode").length() <= 15);
    CHECK(portKey(BOARD.ports[i].name, "id").length() <= 15);
  }
  for (const char* key : {"sensor", "server", "apikey", "interval", "id_temp", "id_humi", "id_press"}) CHECK(String(key).length() <= 15);
  // ID の初期値（atom-<識別>-<ポート名>）は、FactorEye の ID に使える文字だけで、64 バイトに収まる
  for (size_t i = 0; i < BOARD.portCount; i++) {
    String id = String(BOARD.idPrefix) + "-" + "b665" + "-" + String(BOARD.ports[i].name);
    CHECK(id.length() <= 64);
    for (char c : id) CHECK(isalnum((unsigned char)c) || c == '-' || c == '.' || c == '_');
  }
  // 設定モードのアクセスポイント名（M5-機種名-Setup-XXXX）: M5 で始まり、20 バイト以内（SSID は 32 バイトまで。末尾の -XXXX は 5 バイト）
  CHECK(String(BOARD.apPrefix).startsWith("M5-"));
  CHECK(strlen(BOARD.apPrefix) <= 20);
  CHECK(String(BOARD.apPrefix).indexOf(' ') < 0);
  CHECK(strstr(BOARD.apPrefix, "Setup") != nullptr);
  CHECK(portKey("G19", "mode") == String("g19_mode"));
  CHECK(portKey("G5", "id") == String("g5_id"));

  // ポート名が重複しない（保存名がぶつからない）
  for (size_t i = 0; i < BOARD.portCount; i++)
    for (size_t j = i + 1; j < BOARD.portCount; j++) CHECK(String(BOARD.ports[i].name) != String(BOARD.ports[j].name));

  // 機種の定義
#if defined(ARDUINO_M5STACK_ATOM)
  CHECK(String(BOARD.name) == String("ATOM Lite"));
  CHECK(BOARD.buttonPin == 39 && BOARD.ledPin == 27 && BOARD.sdaPin == 26 && BOARD.sclPin == 32);
  CHECK(BOARD.ledPowerPin == -1 && BOARD.buttonWaitMs == 0);  // 起動の瞬間に押されているかを見る
  for (size_t i = 0; i < BOARD.portCount; i++) {
    const PortInfo& p = BOARD.ports[i];
    CHECK(p.pin != BOARD.sdaPin && p.pin != BOARD.sclPin && p.pin != BOARD.ledPin);  // Grove と LED は使わない
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);                                  // ESP32 は ADC1（32〜39）だけ、WiFi 中も読める
    if (p.inputOnly) CHECK(p.pin >= 34);                                              // 入力専用は G34〜G39
  }
#elif defined(ARDUINO_M5STACK_ATOMS3)
  CHECK(String(BOARD.name) == String("ATOMS3 Lite"));
  CHECK(BOARD.buttonPin == 41 && BOARD.ledPin == 35 && BOARD.sdaPin == 2 && BOARD.sclPin == 1);
  CHECK(BOARD.ledPowerPin == -1 && BOARD.buttonWaitMs == 0);
  for (size_t i = 0; i < BOARD.portCount; i++) {
    const PortInfo& p = BOARD.ports[i];
    CHECK(p.pin != BOARD.sdaPin && p.pin != BOARD.sclPin && p.pin != BOARD.ledPin);
    if (p.analog) CHECK(p.pin >= 1 && p.pin <= 10);  // ESP32-S3 の ADC1 は G1〜G10
  }
#elif defined(ARDUINO_M5STACK_NANOC6)
  CHECK(String(BOARD.name) == String("NanoC6"));
  CHECK(BOARD.buttonPin == 9 && BOARD.ledPin == 20 && BOARD.sdaPin == 2 && BOARD.sclPin == 1);
  CHECK(BOARD.ledPowerPin == 19);                       // RGB LED の電源
  CHECK(BOARD.buttonWaitMs >= 3000);                    // G9 は起動のモード選びのピン。押したまま起動できないので、起動後に待つ
  CHECK(BOARD.portCount == 0);                          // 外に出ているピンは Grove（ENV 用）だけ
#elif defined(ARDUINO_M5STACK_STICKC) || defined(ARDUINO_M5STACK_STICKC_PLUS) || defined(ARDUINO_M5STACK_STICKC_PLUS2)
  CHECK(BOARD.buttonPin == 37 && BOARD.sdaPin == 32 && BOARD.sclPin == 33);  // ボタン A・Grove
  CHECK(BOARD.ledMono);                                                       // 赤い LED が 1 つだけ
  CHECK(BOARD.buttonWaitMs >= 3000);                                          // 起動後に待つ方式
  for (size_t i = 0; i < BOARD.portCount; i++) {
    const PortInfo& p = BOARD.ports[i];
    CHECK(p.pin != BOARD.sdaPin && p.pin != BOARD.sclPin && p.pin != BOARD.ledPin && p.pin != BOARD.buttonPin);
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);  // ADC1
    if (p.inputOnly) CHECK(p.pin >= 34);
  }
#if defined(ARDUINO_M5STACK_STICKC_PLUS2)
  CHECK(String(BOARD.name) == String("M5StickC Plus2") && BOARD.powerHoldPin == 4);
#elif defined(ARDUINO_M5STACK_STICKC_PLUS)
  CHECK(String(BOARD.name) == String("M5StickC Plus") && BOARD.ledPin == 10 && BOARD.ledActiveLow && BOARD.powerHoldPin == -1);
#else
  CHECK(String(BOARD.name) == String("M5StickC") && BOARD.ledPin == 10 && BOARD.ledActiveLow && BOARD.powerHoldPin == -1);
#endif
#elif defined(ARDUINO_M5STACK_CORE)
  CHECK(String(BOARD.name) == String("M5Stack Basic"));
  CHECK(BOARD.buttonPin == 39 && BOARD.sdaPin == 21 && BOARD.sclPin == 22);  // ボタン A・Grove の Port A
  CHECK(BOARD.ledPin == -1 && BOARD.hasDisplay);                              // LED はなく、画面に状態を出す
  CHECK(BOARD.buttonWaitMs >= 3000);
  for (size_t i = 0; i < BOARD.portCount; i++) {
    const PortInfo& p = BOARD.ports[i];
    CHECK(p.pin != BOARD.sdaPin && p.pin != BOARD.sclPin && p.pin != BOARD.buttonPin);
    CHECK(p.pin != 16 && p.pin != 17);                // PSRAM つきの個体が使うピンは、ポートにしない
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);  // ADC1
    if (p.inputOnly) CHECK(p.pin >= 34);
  }
#endif
  CHECK(BOARD.portCount == 0 || BOARD.ports != nullptr);
  CHECK(BOARD.hasDisplay == (BOARD.ledPin < 0 && BOARD.portCount > 0 && String(BOARD.idPrefix) == String("core")));  // 画面つきは、今は M5Stack Basic だけ
  CHECK(BOARD.ledMono || !BOARD.ledActiveLow);  // 向きの指定は、1 色の LED のときだけ

  // 使い方の選択肢: アナログは ADC1 のポートだけ、プルアップと出力は入力専用でないポートだけ
  PortInfo g33 = {"G33", 33, true, false, ""};
  PortInfo g19 = {"G19", 19, false, false, ""};
  PortInfo g39 = {"G39", 39, false, true, ""};
  CHECK(portModeOptions(g19) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）|dinpu=デジタル入力（プルアップ）|dout=デジタル出力"));
  CHECK(portModeOptions(g33) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）|dinpu=デジタル入力（プルアップ）|ain=アナログ入力（電圧）|dout=デジタル出力"));
  CHECK(portModeOptions(g39) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）"));

  CHECK(parsePortMode("pulse") == PortMode::Pulse);
  CHECK(isOnLevelLow("low") && isOnLevelLow("") && isOnLevelLow("xyz") && !isOnLevelLow("high"));  // high 以外は LOW（初期値）
  // パルスを数える使い方は、すべてのポートで選べる（入力専用のポートも。内部プルアップは使わない）
  for (size_t i = 0; i < BOARD.portCount; i++) CHECK(portModeOptions(BOARD.ports[i]).indexOf("pulse=") >= 0);
  // パルスのポートの設定項目の保存名は、15 文字まで
  for (size_t i = 0; i < BOARD.portCount; i++) {
    for (const char* suffix : {"mode", "id", "lvl", "deb", "stop", "idrun"}) CHECK(portKey(BOARD.ports[i].name, suffix).length() <= 15);
  }
  CHECK(PULSE_WINDOW_MS == 5000 && PULSE_SEND_BUFFER_GUARD < 100);  // 溜め場（100 件）より、小さい
  CHECK(PULSE_DEBOUNCE_DEFAULT_MS >= 0 && PULSE_DEBOUNCE_DEFAULT_MS <= PULSE_DEBOUNCE_MAX_MS);
  CHECK(PULSE_STOP_DEFAULT_SECONDS >= 1 && PULSE_STOP_DEFAULT_SECONDS <= PULSE_STOP_MAX_SECONDS);
  CHECK(parsePortMode("din") == PortMode::DigitalIn);
  CHECK(parsePortMode("dinpu") == PortMode::DigitalInPullup);
  CHECK(parsePortMode("ain") == PortMode::AnalogIn);
  CHECK(parsePortMode("dout") == PortMode::DigitalOut);
  CHECK(parsePortMode("off") == PortMode::Off);
  CHECK(parsePortMode("") == PortMode::Off);
  CHECK(parsePortMode("xyz") == PortMode::Off);

  CHECK(intervalMs(30) == 30000);
  CHECK(intervalMs(0) == 5000);      // 保存が壊れても、速すぎない
  CHECK(intervalMs(-5) == 5000);
  CHECK(intervalMs(999999) == 3600000);

  CHECK(isSaneTemperature(25.3f) && !isSaneTemperature(-60) && !isSaneTemperature(200));
  CHECK(isSaneHumidity(55) && !isSaneHumidity(-1) && !isSaneHumidity(101));
  CHECK(isSanePressure(1013.2f) && !isSanePressure(0) && !isSanePressure(101325));  // Pa のまま渡したときは外れる

  CHECK(isHttpAddress("http://192.168.1.50:8000"));
  CHECK(!isHttpAddress("https://example.com"));  // FactorEyeClient は https 未対応
  CHECK(!isHttpAddress("192.168.1.50:8000"));
  CHECK(!isHttpAddress("http://"));
  CHECK(!isHttpAddress(""));

  CHECK(normalizeServerAddress("http://192.168.1.50:8000/") == String("http://192.168.1.50:8000"));
  CHECK(normalizeServerAddress("  http://a:8000///  ") == String("http://a:8000"));
  CHECK(normalizeServerAddress("http://a") == String("http://a"));
  CHECK(normalizeServerAddress("") == String(""));

  // 送り先ごとの異常: 1 つの ID だけ送れていなくても見つける
  SendTarget targets[2];
  targets[0].lastSuccessMs = 100000;
  targets[1].lastSuccessMs = 100000;
  CHECK(!anyTargetStalled(targets, 2, 150000, 120000));
  targets[0].lastSuccessMs = 200000;   // 温度は送れ続けている
  CHECK(anyTargetStalled(targets, 2, 230000, 120000));   // 湿度（targets[1]）は 130 秒送れていない
  CHECK(!anyTargetStalled(targets, 0, 999999, 120000));  // 送るものがなければ、ここでは異常にしない（設定の問題として別に扱う）

  // Sensirion の CRC（データシートの例: 0xBEEF → 0x92）と、シリアル番号の応答の確認
  const uint8_t beef[] = {0xBE, 0xEF};
  CHECK(sensirionCrc8(beef, 2) == 0x92);
  const uint8_t goodSerial[] = {0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x92};
  CHECK(isValidSensirionSerial(goodSerial));
  const uint8_t badFirst[] = {0xBE, 0xEF, 0x00, 0xBE, 0xEF, 0x92};
  const uint8_t badSecond[] = {0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x00};
  const uint8_t allFF[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  const uint8_t allZero[] = {0, 0, 0, 0, 0, 0};
  CHECK(!isValidSensirionSerial(badFirst) && !isValidSensirionSerial(badSecond));
  CHECK(!isValidSensirionSerial(allFF) && !isValidSensirionSerial(allZero));  // 応答なし（バスが引き上げられた値）を、正しいとしない

  CHECK(sendFailureLimitMs(10000) == 120000);   // 間隔が短くても 2 分
  CHECK(sendFailureLimitMs(60000) == 180000);   // 間隔の 3 倍
  CHECK(sendFailureLimitMs(300000) == 900000);

  std::printf("%d 件の確認のうち、失敗 %d 件\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
