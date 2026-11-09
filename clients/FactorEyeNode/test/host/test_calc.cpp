// FactorEyeNode の機種ごとのピンと設定の決まり（node_calc.h）を PC 上で確かめる。実行: ./run.sh
// Arduino の偽物は fakes/ にある。
// run.sh が、機種ごとに -DARDUINO_M5STACK_ATOM などを付けて、機種の数だけコンパイルして実行する
#if !defined(ARDUINO_M5STACK_ATOM) && !defined(ARDUINO_M5STACK_ATOMS3) && !defined(ARDUINO_M5STACK_NANOC6) && \
    !defined(ARDUINO_M5STACK_STICKC) && !defined(ARDUINO_M5STACK_STICKC_PLUS) && !defined(ARDUINO_M5STACK_STICKC_PLUS2) && \
    !defined(ARDUINO_M5STACK_CORE)
#define ARDUINO_M5STACK_ATOM 1
#endif
#include <cstdio>
#include <cstring>

#include "node_calc.h"

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
  for (int i = 0; i < PORT_COUNT; i++) {
    CHECK(port_key(PORTS[i].name, "mode").length() <= 15);
    CHECK(port_key(PORTS[i].name, "id").length() <= 15);
  }
  for (const char* key : {"sensor", "server", "apikey", "interval", "id_temp", "id_humi", "id_press"}) CHECK(String(key).length() <= 15);
  // ID の初期値（atom-<識別>-<ポート名>）は、FactorEye の ID に使える文字だけで、64 バイトに収まる
  for (int i = 0; i < PORT_COUNT; i++) {
    String id = String(ID_PREFIX) + "-" + "b665" + "-" + String(PORTS[i].name);
    CHECK(id.length() <= 64);
    for (char c : id) CHECK(isalnum((unsigned char)c) || c == '-' || c == '.' || c == '_');
  }
  // 設定モードのアクセスポイント名（M5-機種名-Setup-XXXX）: M5 で始まり、20 バイト以内（SSID は 32 バイトまで。末尾の -XXXX は 5 バイト）
  CHECK(String(AP_NAME).startsWith("M5-"));
  CHECK(strlen(AP_NAME) <= 20);
  CHECK(String(AP_NAME).indexOf(' ') < 0);
  CHECK(strstr(AP_NAME, "Setup") != nullptr);
  CHECK(port_key("G19", "mode") == String("g19_mode"));
  CHECK(port_key("G5", "id") == String("g5_id"));

  // ポート名が重複しない（保存名がぶつからない）
  for (int i = 0; i < PORT_COUNT; i++)
    for (int j = i + 1; j < PORT_COUNT; j++) CHECK(String(PORTS[i].name) != String(PORTS[j].name));

  // 機種の定義
#if defined(ARDUINO_M5STACK_ATOM)
  CHECK(String(BOARD_NAME) == String("ATOM Lite"));
  CHECK(BTN_PIN == 39 && LED_PIN == 27 && I2C_SDA == 26 && I2C_SCL == 32);
  CHECK(LED_POWER_PIN == -1 && BTN_WAIT_MS == 0);  // 起動の瞬間に押されているかを見る
  for (int i = 0; i < PORT_COUNT; i++) {
    const PORT_INFO& p = PORTS[i];
    CHECK(p.pin != I2C_SDA && p.pin != I2C_SCL && p.pin != LED_PIN);  // Grove と LED は使わない
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);                                  // ESP32 は ADC1（32〜39）だけ、WiFi 中も読める
    if (p.input_only) CHECK(p.pin >= 34);                                              // 入力専用は G34〜G39
  }
#elif defined(ARDUINO_M5STACK_ATOMS3)
  CHECK(String(BOARD_NAME) == String("ATOMS3 Lite"));
  CHECK(BTN_PIN == 41 && LED_PIN == 35 && I2C_SDA == 2 && I2C_SCL == 1);
  CHECK(LED_POWER_PIN == -1 && BTN_WAIT_MS == 0);
  for (int i = 0; i < PORT_COUNT; i++) {
    const PORT_INFO& p = PORTS[i];
    CHECK(p.pin != I2C_SDA && p.pin != I2C_SCL && p.pin != LED_PIN);
    if (p.analog) CHECK(p.pin >= 1 && p.pin <= 10);  // ESP32-S3 の ADC1 は G1〜G10
  }
#elif defined(ARDUINO_M5STACK_NANOC6)
  CHECK(String(BOARD_NAME) == String("NanoC6"));
  CHECK(BTN_PIN == 9 && LED_PIN == 20 && I2C_SDA == 2 && I2C_SCL == 1);
  CHECK(LED_POWER_PIN == 19);                       // RGB LED の電源
  CHECK(BTN_WAIT_MS >= 3000);                    // G9 は起動のモード選びのピン。押したまま起動できないので、起動後に待つ
  CHECK(PORT_COUNT == 0);                          // 外に出ているピンは Grove（ENV 用）だけ
#elif defined(ARDUINO_M5STACK_STICKC) || defined(ARDUINO_M5STACK_STICKC_PLUS) || defined(ARDUINO_M5STACK_STICKC_PLUS2)
  CHECK(BTN_PIN == 37 && I2C_SDA == 32 && I2C_SCL == 33);  // ボタン A・Grove
  CHECK(LED_MONO);                                                       // 赤い LED が 1 つだけ
  CHECK(BTN_WAIT_MS >= 3000);                                          // 起動後に待つ方式
  for (int i = 0; i < PORT_COUNT; i++) {
    const PORT_INFO& p = PORTS[i];
    CHECK(p.pin != I2C_SDA && p.pin != I2C_SCL && p.pin != LED_PIN && p.pin != BTN_PIN);
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);  // ADC1
    if (p.input_only) CHECK(p.pin >= 34);
  }
#if defined(ARDUINO_M5STACK_STICKC_PLUS2)
  CHECK(String(BOARD_NAME) == String("M5StickC Plus2") && POWER_HOLD_PIN == 4);
#elif defined(ARDUINO_M5STACK_STICKC_PLUS)
  CHECK(String(BOARD_NAME) == String("M5StickC Plus") && LED_PIN == 10 && LED_LOW && POWER_HOLD_PIN == -1);
#else
  CHECK(String(BOARD_NAME) == String("M5StickC") && LED_PIN == 10 && LED_LOW && POWER_HOLD_PIN == -1);
#endif
#elif defined(ARDUINO_M5STACK_CORE)
  CHECK(String(BOARD_NAME) == String("M5Stack Basic"));
  CHECK(BTN_PIN == 39 && I2C_SDA == 21 && I2C_SCL == 22);  // ボタン A・Grove の Port A
  CHECK(LED_PIN == -1 && HAS_SCREEN == 1);                              // LED はなく、画面に状態を出す
  CHECK(BTN_WAIT_MS >= 3000);
  for (int i = 0; i < PORT_COUNT; i++) {
    const PORT_INFO& p = PORTS[i];
    CHECK(p.pin != I2C_SDA && p.pin != I2C_SCL && p.pin != BTN_PIN);
    CHECK(p.pin != 16 && p.pin != 17);                // PSRAM つきの個体が使うピンは、ポートにしない
    if (p.analog) CHECK(p.pin >= 32 && p.pin <= 39);  // ADC1
    if (p.input_only) CHECK(p.pin >= 34);
  }
#endif
  CHECK((HAS_SCREEN == 1) == (LED_PIN < 0 && PORT_COUNT > 0 && String(ID_PREFIX) == String("core")));  // 画面つきは、今は M5Stack Basic だけ
  CHECK(LED_MONO || !LED_LOW);  // 向きの指定は、1 色の LED のときだけ

  // 使い方の選択肢: アナログは ADC1 のポートだけ、プルアップと出力は入力専用でないポートだけ
  PORT_INFO g33 = {"G33", 33, true, false, ""};
  PORT_INFO g19 = {"G19", 19, false, false, ""};
  PORT_INFO g39 = {"G39", 39, false, true, ""};
  CHECK(port_options(g19) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）|dinpu=デジタル入力（プルアップ）|dout=デジタル出力"));
  CHECK(port_options(g33) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）|dinpu=デジタル入力（プルアップ）|ain=アナログ入力（電圧）|dout=デジタル出力"));
  CHECK(port_options(g39) == String("off=使わない|din=デジタル入力|pulse=パルスを数える（生産数）"));

  CHECK(parse_port_mode("pulse") == PORT_PULSE);
  CHECK(on_level_low("low") && on_level_low("") && on_level_low("xyz") && !on_level_low("high"));  // high 以外は LOW（初期値）
  // パルスを数える使い方は、すべてのポートで選べる（入力専用のポートも。内部プルアップは使わない）
  for (int i = 0; i < PORT_COUNT; i++) CHECK(port_options(PORTS[i]).indexOf("pulse=") >= 0);
  // パルスのポートの設定項目の保存名は、15 文字まで
  for (int i = 0; i < PORT_COUNT; i++) {
    for (const char* suffix : {"mode", "id", "lvl", "deb", "stop", "idrun"}) CHECK(port_key(PORTS[i].name, suffix).length() <= 15);
  }
  CHECK(PULSE_WINDOW_MS == 5000 && PULSE_BUFFER_GUARD < 100);  // 溜め場（100 件）より、小さい
  CHECK(PULSE_DEB_DEFAULT >= 0 && PULSE_DEB_DEFAULT <= PULSE_DEB_MAX);
  CHECK(PULSE_STOP_DEFAULT >= 1 && PULSE_STOP_DEFAULT <= PULSE_STOP_MAX);
  CHECK(parse_port_mode("din") == PORT_DIN);
  CHECK(parse_port_mode("dinpu") == PORT_DINPU);
  CHECK(parse_port_mode("ain") == PORT_AIN);
  CHECK(parse_port_mode("dout") == PORT_DOUT);
  CHECK(parse_port_mode("off") == PORT_OFF);
  CHECK(parse_port_mode("") == PORT_OFF);
  CHECK(parse_port_mode("xyz") == PORT_OFF);

  CHECK(interval_ms(30) == 30000);
  CHECK(interval_ms(0) == 5000);      // 保存が壊れても、速すぎない
  CHECK(interval_ms(-5) == 5000);
  CHECK(interval_ms(999999) == 3600000);

  CHECK(ok_temp(25.3f) && !ok_temp(-60) && !ok_temp(200));
  CHECK(ok_hum(55) && !ok_hum(-1) && !ok_hum(101));
  CHECK(ok_press(1013.2f) && !ok_press(0) && !ok_press(101325));  // Pa のまま渡したときは外れる

  CHECK(http_address("http://192.168.1.50:8000"));
  CHECK(!http_address("https://example.com"));  // FactorEyeClient は https 未対応
  CHECK(!http_address("192.168.1.50:8000"));
  CHECK(!http_address("http://"));
  CHECK(!http_address(""));

  CHECK(clean_address("http://192.168.1.50:8000/") == String("http://192.168.1.50:8000"));
  CHECK(clean_address("  http://a:8000///  ") == String("http://a:8000"));
  CHECK(clean_address("http://a") == String("http://a"));
  CHECK(clean_address("") == String(""));

  // 送り先ごとの異常: 1 つの ID だけ送れていなくても見つける
  SEND_TARGET targets[2];
  targets[0].ok_ms = 100000;
  targets[1].ok_ms = 100000;
  CHECK(!any_stalled(targets, 2, 150000, 120000));
  targets[0].ok_ms = 200000;   // 温度は送れ続けている
  CHECK(any_stalled(targets, 2, 230000, 120000));   // 湿度（targets[1]）は 130 秒送れていない
  CHECK(!any_stalled(targets, 0, 999999, 120000));  // 送るものがなければ、ここでは異常にしない（設定の問題として別に扱う）

  // Sensirion の CRC（データシートの例: 0xBEEF → 0x92）と、シリアル番号の応答の確認
  const uint8_t beef[] = {0xBE, 0xEF};
  CHECK(sht_crc(beef, 2) == 0x92);
  const uint8_t goodSerial[] = {0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x92};
  CHECK(sht_serial_ok(goodSerial));
  const uint8_t badFirst[] = {0xBE, 0xEF, 0x00, 0xBE, 0xEF, 0x92};
  const uint8_t badSecond[] = {0xBE, 0xEF, 0x92, 0xBE, 0xEF, 0x00};
  const uint8_t allFF[] = {0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF};
  const uint8_t allZero[] = {0, 0, 0, 0, 0, 0};
  CHECK(!sht_serial_ok(badFirst) && !sht_serial_ok(badSecond));
  CHECK(!sht_serial_ok(allFF) && !sht_serial_ok(allZero));  // 応答なし（バスが引き上げられた値）を、正しいとしない

  CHECK(fail_limit_ms(10000) == 120000);   // 間隔が短くても 2 分
  CHECK(fail_limit_ms(60000) == 180000);   // 間隔の 3 倍
  CHECK(fail_limit_ms(300000) == 900000);

  std::printf("%d 件の確認のうち、失敗 %d 件\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
