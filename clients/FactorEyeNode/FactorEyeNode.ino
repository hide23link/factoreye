/* FactorEyeNode ver3.00
 *  M5Stack（ATOM Lite など）の ENV センサー（温度・湿度・気圧）と入出力ポートの値を、FactorEye に送る。
 *  2026/11/5 ver1 作成。2026/11/8 ver2 .ino と node_calc.h の 2 つに整理。
 *  2026/11/9 ver3 書き方をそろえた（動きは ver2 と同じ）
 *  （SPEC.md の「版 0.3」は仕様の版で、この版とは別に数える）
 *  使い方は README.md、仕様の詳細は SPEC.md
 *
 *  機種: ATOM Lite / ATOMS3 Lite / NanoC6 / M5StickC / M5StickC Plus / M5StickC Plus2 / M5Stack Basic
 *        ボードの種類で決まる（ピンと使えるポートは node_calc.h の「機種ごとのピン」。PC で試験しているので、ここには写さない）
 *  設定モード: ボタンを押しながら電源ON、または必須の設定が未入力（NanoC6・StickC・Basic は起動後の数秒の間に押す）
 *              → スマホで WiFi「M5-機種名-Setup-XXXX」につなぐ → センサー・送り先・書き込む ID・ポートを入れて保存 → 再起動
 *  LED: 赤点滅=設定モード 青点滅=WiFi に接続中 青点灯=動作中 黄色の点滅=異常（設定の誤り・センサーが無い・送信が続けて失敗）
 *       （LED と WiFi は WifiStarter（src/WifiStarter/、同梱）がやる。M5Stack Basic は LED のかわりに画面に出す）
 *  再送: 送れなかった値は FactorEyeClient が溜めて（最大100件）、あとで送る
 *
 *  ---- 全体の流れ ----
 *  setup()   : 電源を保つ → 画面 → WiFi（設定モード）→ 設定を読む → 送る部品 → ポート → 送る ID の一覧 → ENV
 *  loop()    : WiFi のつなぎ直し → ENV のやり直し → サーバーの確認 → 間隔ごとに読んで送る → 5秒ごとにパルスの個数を送る
 *              → 異常の LED → 画面
 *  割り込み  : パルスのポートに信号が来たら、数えるだけ（node_calc.h の pulse_edge）
 *  データの流れ: ENV・ポート → send_（FactorEyeClient が ID ごとに POST する。溜まった分もまとめて送る）→ FactorEye
 *               パルス → 割り込みで数える → send_pulses（5秒ごとの個数と稼働 1/0）→ FactorEye
 *
 *  ---- 関数のまとまり ----
 *  settings_ 設定画面の項目と、保存した設定の読み出し
 *  env_      ENV ユニット（種類の見分け・読む）
 *  port_     入出力ポート（使い方に合わせてピンを用意する・パルスの割り込み）
 *  target_   送る ID の一覧（ID ごとに最後に送れた時刻。異常の判断に使う）
 *  screen_   画面（M5Stack Basic だけ）
 *  server_   サーバーに届くかの確認（原因の切り分け用）
 *  send_     送る（間隔ごとの値・5秒ごとのパルス）
 *  warning_  異常の LED（黄色の点滅）
 *  power_    電源を保つ（M5StickC Plus2 だけ）
 *  wifi_     WiFi（設定画面の項目の登録・始める）
 *
 *  ---- 並べ方 ----
 *  データの入れ物（struct）→ まとまりごとに「データ → そのデータを扱う関数」→ いちばん最後に setup()・loop()
 *
 *  ---- 名前の決まり ----
 *  グローバル変数は頭に g_、決まった値は const で全部大文字、関数名は小文字と _ で頭にまとまりの名前
 *  サーバーに送る ID の初期値（atom-xxxx-temp など）と、本体に保存する設定の名前（"server"・"g19_mode" など）は、
 *  サーバーの登録・書き込み済みの機器と合わせるため変えない
 *  node_calc.h の名前（PORT_INFO・PULSE・BOARD_NAME など）は、PC の試験と合わせるため、そのまま使う
 */
#include <FactorEyeClient.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_mac.h>
#include <M5UnitENV.h>                     // ENVユニット（SHT30・SHT40・QMP6988・BMP280）
#include "src/WifiStarter/WifiStarter.h"   // WiFi 設定・接続・LED（同梱）
#include "node_calc.h"                     // 機種ごとのピン・設定の決まり・パルスの数え方（PC で試験する）
#if HAS_SCREEN
#include <M5Unified.h>                     // 画面つきの機種（M5Stack Basic）だけ
#endif

// 書き込みのときに -D で変える値は無い（機種はボードの種類で決まる。設定はすべてスマホの設定画面で入れる）

//****************************************************************
//  データの入れ物（struct）
//  関数の引数に使う struct は、ここ（最初の関数より前）に置く。
//  Arduino は関数の宣言を自動で最初の関数の前に出すが、struct は出さないので、後ろに置くとコンパイルで止まる
//****************************************************************

// ポート 1つ分の設定（保存した値から作る）。port_ の関数が作り、send_ の関数が読む
struct PortSetting {
  const PORT_INFO *port;    // どのポートか（node_calc.h の PORTS の 1つ。例: G19）
  int mode;                 // 使い方（PORT_OFF・PORT_DIN・PORT_DINPU・PORT_PULSE・PORT_AIN・PORT_DOUT）
  String id;                // 書き込む ID（パルスのときは個数。例: "atom-b665-G19"）
  PULSE pulse;              // パルスのときだけ使う（割り込みで数える）
  String run_id;            // 稼働（1/0）を送る ID。空なら送らない
  unsigned long stop_ms;    // 停止とみなす時間 ミリ秒（例: 60000）
  int external_signal;      // 外部の稼働・停止の信号（RUN_UNKNOWN・RUN_ON・RUN_OFF。いまは常に RUN_UNKNOWN）
};

//****************************************************************
//  settings_ … 設定画面の項目と、保存した設定の読み出し
//  設定の名前（"sensor"・"server"・"apikey"・"interval"・"id_temp"・"id_humi"・"id_press"、
//  ポートごとの "g19_mode" など）は、書き込み済みの機器に保存してある値を読むため変えない
//****************************************************************
bool g_use_env = true;                 // true = ENV ユニットを使う（設定 "sensor" が "auto"）、false = つながない（"none"）
String g_id_temperature;               // 温度の書き込む ID（例: "atom-b665-temp"。空なら送らない）
String g_id_humidity;                  // 湿度の書き込む ID（例: "atom-b665-humi"）
String g_id_pressure;                  // 気圧の書き込む ID（例: "atom-b665-press"）
unsigned long g_send_interval_ms = 30000;   // 送る間隔 ミリ秒（10000・30000・60000・300000）
String g_server_url;                   // 送り先（例: "http://192.168.1.50:8000"。前後の空白と末尾の / は取ってある）
bool g_settings_problem = false;       // true = サーバーアドレスが正しくない・送るものがない（黄色の点滅で知らせる）

// 設定画面の項目を登録する（WifiStarter.begin() の前に呼ぶ）
// 引数: なし
// 戻り値: なし
void settings_items() {
  WifiStarter.setTitle("センサーノード設定");

  WifiStarter.addGroup("② センサー");
  // 以前の版で保存した ENV2・ENV3・ENV4 の値も「自動」として扱う
  WifiStarter.addSelect("sensor", "ENV ユニット（Grove）", "auto=自動で見分ける（ENV2・ENV3・ENV4）|none=つながない（ポートだけ使う）", "auto")
      .help(String("Grove: SDA G") + I2C_SDA + " / SCL G" + I2C_SCL + "。温度・湿度・気圧を読みます。ユニットを差し替えても、設定は変えなくてよい");

  WifiStarter.addGroup("③ 送り先（FactorEye）");
  WifiStarter.addText("server", "サーバーアドレス", "", 80).required().startsWith("http://")
      .placeholder("http://192.168.1.50:8000").help("http:// で始めます（https は未対応）");
  // 空なら X-API-Key を付けずに送る（キーなしで受け付けるサーバー向け）
  WifiStarter.addPassword("apikey", "API キー（なしでも可）").clearable()
      .help("キーが必要なサーバー（FactorEye の INGEST_API_KEY）のときだけ入力します。空のまま保存すると、今の値を残します");
  WifiStarter.addSelect("interval", "送る間隔", "10=10 秒|30=30 秒|60=1 分|300=5 分", "30");

  //****** 書き込む ID。初期値に台ごとの識別を入れる（同じ ID に複数の台が書くと値が混ざる） ******
  String head = String(ID_PREFIX) + "-" + settings_mac_end() + "-";   // 例: "atom-b665-"
  const char *sensor_shown = "sensor=auto";   // センサーをつなぐときだけ表示
  WifiStarter.addGroup("④ 書き込む ID（FactorEye に登録した ID）");
  WifiStarter.addText("id_temp", "温度", head + "temp").mono().identifier().required().showWhen(sensor_shown);
  WifiStarter.addText("id_humi", "湿度", head + "humi").mono().identifier().required().showWhen(sensor_shown);
  WifiStarter.addText("id_press", "気圧", head + "press")
      .mono().identifier().required().showWhen(sensor_shown)
      .help("FactorEye に同じ ID のセンサーを先に登録しておきます（未登録の ID は送れません）。台ごとに変えてください。半角の英数字と . _ - が使えます。単位: ℃・%・hPa");

  //****** 入出力ポート ******
  WifiStarter.addGroup(String("⑤ 入出力ポート（") + BOARD_NAME + "）");
  for (int i = 0; i < PORT_COUNT; i++) {
    const PORT_INFO &port = PORTS[i];
    String mode_key = port_key(port.name, "mode");   // 例: "g19_mode"
    String pulse_only = mode_key + "=pulse";         // パルスを数えるときだけ表示
    WifiStarter.addSelect(mode_key, String(port.name) + " の使い方（" + port.note + "）", port_options(port), "off");
    WifiStarter.addSelect(port_key(port.name, "lvl"), String(port.name) + " センサーが ON のときの電圧",
                          "low=LOW（NPN・接点。内部プルアップを使う）|high=HIGH（PNP）", "low")
        .showWhen(pulse_only)
        .help(port.input_only ? "入力専用のポートは、内部プルアップがないので、LOW のときは、外付けの抵抗が要ります"
                              : "センサーの出力が、ON のとき LOW になる型（NPN・接点）か、HIGH になる型（PNP）か");
    WifiStarter.addNumber(port_key(port.name, "deb"), String(port.name) + " デバウンス（ミリ秒）", PULSE_DEB_DEFAULT, 0, PULSE_DEB_MAX)
        .showWhen(pulse_only)
        .help("短いチャタリングを、1 つとして数えない時間。物体の最短の間隔より、短くします");
    WifiStarter.addNumber(port_key(port.name, "stop"), String(port.name) + " 停止とみなす秒数", PULSE_STOP_DEFAULT, 1, PULSE_STOP_MAX)
        .showWhen(pulse_only)
        .help("最後の信号から、この秒数なければ「停止」。物体の最長の間隔より、長くします（10 秒以上の間隔のラインは、10 より大きく）");
    WifiStarter.addText(port_key(port.name, "id"), String(port.name) + " の書き込む ID（パルスのときは、個数）", head + port.name)
        .mono().identifier().required().showWhen(mode_key + "=din|dinpu|ain|pulse");
    WifiStarter.addText(port_key(port.name, "idrun"), String(port.name) + " 稼働 ID（なくてもよい）", "")
        .mono().identifier().showWhen(pulse_only)
        .help("5 秒ごとに、稼働なら 1、停止なら 0 を送ります。空なら送りません（個数だけ送ります）");
  }
}

// この本体の識別（MAC の下4桁。設定モードの WiFi 名の末尾と同じ）。ID の初期値を台ごとに変えるため
// 引数: なし
// 戻り値: 16進の 4文字（例: "b665"）
String settings_mac_end() {
  uint8_t mac[6];
  char text[5];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  snprintf(text, sizeof(text), "%02x%02x", mac[4], mac[5]);
  return text;
}

// 保存してある設定（センサー・書き込む ID・送る間隔・送り先）を読み出す（WifiStarter.begin() の後に呼ぶ）
// ポートの設定は port_start()、API キーは send_begin() が読む
// 引数: なし
// 戻り値: なし
void settings_read() {
  g_use_env = WifiStarter.setting("sensor") != "none";   // 以前の版の ENV2・ENV3・ENV4 も自動（使う）として扱う
  g_id_temperature = WifiStarter.setting("id_temp");
  g_id_humidity = WifiStarter.setting("id_humi");
  g_id_pressure = WifiStarter.setting("id_press");
  g_send_interval_ms = interval_ms(WifiStarter.settingInt("interval", 30));

  g_server_url = clean_address(WifiStarter.setting("server"));
  g_settings_problem = !http_address(g_server_url);
  if (g_settings_problem) Serial.println("[Node] サーバーアドレスは http:// で始めてください（送信できません）");
}

//****************************************************************
//  env_ … ENV ユニット（ENV2・ENV3・ENV4 を自動で見分ける）
//****************************************************************
const int ENV_NONE = 0;
const int ENV2 = 2;   // SHT30 + BMP280
const int ENV3 = 3;   // SHT30 + QMP6988
const int ENV4 = 4;   // SHT40 + BMP280
const uint32_t I2C_SPEED = 400000;      // I2C の速さ Hz
const uint32_t ENV_RETRY_MS = 30000;    // ENV が見つからないとき、やり直す間隔 ミリ秒

SHT3X g_sht30;
SHT4X g_sht40;
QMP6988 g_qmp6988;
BMP280 g_bmp280;
int g_env_type = ENV_NONE;   // 使える ENV の種類（ENV_NONE・ENV2・ENV3・ENV4）。setup と loop の両方で使う

// ENV を使えるようにする（setup から呼ぶ。見つからないときは、loop の env_retry() がやり直す）
// 引数: なし
// 戻り値: true = 使える（ENV を使わない設定のときも true）、false = 見つからない・始められない
bool env_begin() {
  if (!g_use_env) return true;
  g_env_type = env_find_type();
  if (g_env_type == ENV_NONE) return false;
  Serial.printf("[ENV] 自動判別: ENV%d\n", g_env_type);
  bool ok1, ok2;   // ok1 = 温湿度、ok2 = 気圧
  if (g_env_type == ENV4) ok1 = g_sht40.begin(&Wire, SHT40_I2C_ADDR_44, I2C_SDA, I2C_SCL, I2C_SPEED);
  else                    ok1 = g_sht30.begin(&Wire, SHT3X_I2C_ADDR, I2C_SDA, I2C_SCL, I2C_SPEED);
  if (g_env_type == ENV3) ok2 = g_qmp6988.begin(&Wire, QMP6988_SLAVE_ADDRESS_L, I2C_SDA, I2C_SCL, I2C_SPEED);
  else                    ok2 = g_bmp280.begin(&Wire, BMP280_I2C_ADDR, I2C_SDA, I2C_SCL, I2C_SPEED);
  if (ok1 && ok2 && g_env_type != ENV3) {
    // BMP280 の標準の設定（M5 のサンプルと同じ）
    g_bmp280.setSampling(BMP280::MODE_NORMAL, BMP280::SAMPLING_X2, BMP280::SAMPLING_X16,
                         BMP280::FILTER_X16, BMP280::STANDBY_MS_500);
  }
  Serial.printf("[ENV] ENV%d 温湿度=%s 気圧=%s\n", g_env_type, ok1 ? "OK" : "見つからない", ok2 ? "OK" : "見つからない");
  if (!ok1 || !ok2) g_env_type = ENV_NONE;
  return g_env_type != ENV_NONE;
}

// ENV が見つからないときは、30秒ごとに探し直す（あとから挿したとき。loop から呼ぶ）
// 引数: なし
// 戻り値: なし
void env_retry() {
  static uint32_t last_try_ms = 0;   // 前に探した時刻 ミリ秒
  if (!g_use_env || g_env_type != ENV_NONE) return;
  if (millis() - last_try_ms <= ENV_RETRY_MS) return;
  last_try_ms = millis();
  env_begin();
}

// 温度と湿度を読む
// 引数: temperature … 温度 ℃ が入る（例: 23.4）
//       humidity    … 湿度 % が入る（例: 45.0）
// 戻り値: true = 読めた、false = 読めない（ENV が無い・応答がない）
bool env_read_climate(float &temperature, float &humidity) {
  if (g_env_type == ENV4) {
    if (!g_sht40.update()) return false;
    temperature = g_sht40.cTemp;
    humidity = g_sht40.humidity;
    return true;
  }
  if (g_env_type == ENV_NONE || !g_sht30.update()) return false;
  temperature = g_sht30.cTemp;
  humidity = g_sht30.humidity;
  return true;
}

// 気圧を読む
// 引数: pressure … 気圧 hPa が入る（例: 1013.2）
// 戻り値: true = 読めた、false = 読めない（ENV が無い・応答がない）
bool env_read_pressure(float &pressure) {
  if (g_env_type == ENV3) {
    if (!g_qmp6988.update()) return false;
    pressure = g_qmp6988.pressure / 100.0;   // Pa → hPa
    return true;
  }
  if (g_env_type == ENV_NONE || !g_bmp280.update()) return false;
  pressure = g_bmp280.pressure / 100.0;
  return true;
}

// ---- ここから下は ENV の種類を調べるだけ。普段は読み飛ばしてよい ----

// どの ENV がつながっているかを調べる
// 引数: なし
// 戻り値: ENV_NONE・ENV2・ENV3・ENV4（例: 3）
int env_find_type() {
  const uint8_t sht40_command[] = {0x89};
  const uint8_t sht30_command[] = {0x37, 0x80};
  Wire.begin(I2C_SDA, I2C_SCL, I2C_SPEED);
  bool sht = env_i2c_answer(0x44);   // SHT30・SHT40（同じアドレス）
  bool qmp = env_i2c_answer(0x70);   // QMP6988（ENV3）
  bool bmp = env_i2c_answer(0x76);   // BMP280（ENV2・ENV4）
  Serial.printf("[ENV] I2C の応答: SHT(0x44)=%s QMP6988(0x70)=%s BMP280(0x76)=%s\n",
                sht ? "あり" : "なし", qmp ? "あり" : "なし", bmp ? "あり" : "なし");
  if (!sht) return ENV_NONE;
  if (qmp) return ENV3;
  if (!bmp) return ENV_NONE;
  if (env_sht_answer(sht40_command, 1)) return ENV4;
  if (env_sht_answer(sht30_command, 2)) return ENV2;
  // どちらも確かめられない → SHT40 の応答が一時的に乱れたことが多いので ENV4 とみなす
  Serial.println("[ENV] 温湿度センサーの種類を確かめられませんでした。ENV4 とみなします");
  return ENV4;
}

// I2C のアドレスに、何かがつながっているか
// 引数: address … I2C のアドレス（例: 0x44）
// 戻り値: true = 答えた、false = 答えない
bool env_i2c_answer(uint8_t address) {
  Wire.beginTransmission(address);
  return Wire.endTransmission() == 0;
}

// シリアル番号を読むコマンドを送り、検査の数（CRC）の合う応答が返るか（3回まで試す）
// SHT40 は 0x89、SHT30 は 0x37 0x80 に答える（相手のコマンドには、まともに答えない）
// 検査の数の計算は node_calc.h の sht_serial_ok（PC で試験している）
// 引数: command … 送るコマンド（例: {0x89}）
//       length  … コマンドのバイト数（1〜2）
// 戻り値: true = 正しく答えた、false = 答えない
bool env_sht_answer(const uint8_t *command, int length) {
  for (int n = 0; n < 3; n++) {
    Wire.beginTransmission(0x44);
    Wire.write(command, length);
    if (Wire.endTransmission() != 0) continue;
    delay(5);
    if (Wire.requestFrom((uint8_t)0x44, (uint8_t)6) != 6) continue;
    uint8_t answer[6];
    for (int i = 0; i < 6; i++) answer[i] = Wire.read();
    if (sht_serial_ok(answer)) return true;
  }
  return false;
}

//****************************************************************
//  port_ … 入出力ポート（使い方に合わせてピンを用意する）
//****************************************************************
const int PORT_SETTING_MAX = 8;   // 使うポートの数の上限（いちばん多い ATOM Lite で 7つ）

PortSetting g_port_settings[PORT_SETTING_MAX];   // 使うポートの設定（使わないポートは入れない）。setup で作り、loop と割り込みで使う
int g_port_count = 0;                            // 使うポートの数（0〜8）

// パルスの割り込み。数えるだけ（割り込みの中なので Serial・String・HTTP は使わない）
// 引数: arg … そのポートの PULSE（attachInterruptArg で渡したもの）
// 戻り値: なし
void IRAM_ATTR port_pulse_interrupt(void *arg) {
  pulse_edge((PULSE *)arg, micros(), millis());
}

// 保存してあるポートの設定を読み、使うポートを g_port_settings に入れて、ピンを用意する（setup から 1回）
// 引数: なし
// 戻り値: なし
void port_start() {
  g_port_count = 0;
  for (int i = 0; i < PORT_COUNT && g_port_count < PORT_SETTING_MAX; i++) {
    const PORT_INFO &port = PORTS[i];
    PortSetting &setting = g_port_settings[g_port_count];
    setting.port = &port;
    setting.mode = parse_port_mode(WifiStarter.setting(port_key(port.name, "mode")));
    setting.id = WifiStarter.setting(port_key(port.name, "id"));
    setting.run_id = WifiStarter.setting(port_key(port.name, "idrun"));
    setting.stop_ms = 0;
    setting.external_signal = RUN_UNKNOWN;
    if (setting.mode == PORT_OFF) continue;   // 使わない → 入れない（次のポートが同じ場所を使う）
    g_port_count++;
    port_pin_begin(setting);
  }
}

// 1つのポートのピンを、使い方に合わせて用意する。パルスのときは割り込みで数え始める
// 引数: setting … そのポートの設定（パルスのときは stop_ms と pulse をここで決める）
// 戻り値: なし
void port_pin_begin(PortSetting &setting) {
  const PORT_INFO &port = *setting.port;
  if (setting.mode == PORT_PULSE) {
    bool on_low = on_level_low(WifiStarter.setting(port_key(port.name, "lvl")));   // true = ON のとき LOW（NPN・接点）
    long debounce_ms = WifiStarter.settingInt(port_key(port.name, "deb"), PULSE_DEB_DEFAULT);   // 0〜1000
    long stop_second = WifiStarter.settingInt(port_key(port.name, "stop"), PULSE_STOP_DEFAULT); // 1〜86400
    setting.stop_ms = (unsigned long)stop_second * 1000UL;
    pinMode(port.pin, (on_low && !port.input_only) ? INPUT_PULLUP : INPUT);   // 入力専用（G34〜G39）は内部プルアップなし
    pulse_begin(&setting.pulse, (uint32_t)debounce_ms * 1000UL, millis());
    attachInterruptArg(digitalPinToInterrupt(port.pin), port_pulse_interrupt, &setting.pulse, on_low ? FALLING : RISING);
  } else if (setting.mode == PORT_DINPU) {
    pinMode(port.pin, INPUT_PULLUP);
  } else if (setting.mode == PORT_DOUT) {
    pinMode(port.pin, OUTPUT);   // 出力の使い方は今後追加
    digitalWrite(port.pin, LOW);
  } else {
    pinMode(port.pin, INPUT);    // デジタル入力・アナログ入力
  }
}

//****************************************************************
//  target_ … 送る ID の一覧（ID ごとに最後に送れた時刻）
//  1つの ID だけ送れない（FactorEye に未登録で 404 など）ことも見つけて、黄色の点滅で知らせるため
//****************************************************************
const int TARGET_MAX = 12;   // 一覧に入れる ID の数の上限

SEND_TARGET g_targets[TARGET_MAX];   // 送る ID と、最後に送れた時刻（node_calc.h の SEND_TARGET）
int g_target_count = 0;              // 一覧の数（0〜12）
unsigned long g_start_ms = 0;        // 起動した時刻 ミリ秒（送れたかの判断に使う。setup で決め、loop で使う）

// 送る ID の一覧を作り、FactorEye 側で自動で作られるときのセンサーの名前と単位を渡す（setup から 1回）
// 送るものが 1つもないときは、設定の問題（黄色の点滅）にする
// 引数: なし
// 戻り値: なし
void target_make() {
  g_target_count = 0;
  if (g_use_env) {
    target_add(g_id_temperature);
    target_add(g_id_humidity);
    target_add(g_id_pressure);
    send_sensor_info(g_id_temperature, "温度", "℃");
    send_sensor_info(g_id_humidity, "湿度", "%");
    send_sensor_info(g_id_pressure, "気圧", "hPa");
  }
  for (int i = 0; i < g_port_count; i++) {
    PortSetting &setting = g_port_settings[i];
    if (setting.mode != PORT_DOUT) target_add(setting.id);
    if (setting.mode == PORT_PULSE) {
      target_add(setting.run_id);
      send_sensor_info(setting.id, "生産数", "個");
      send_sensor_info(setting.run_id, "稼働", "");
    } else if (setting.mode == PORT_AIN) {
      send_sensor_info(setting.id, "入力", "V");
    } else if (setting.mode == PORT_DIN || setting.mode == PORT_DINPU) {
      send_sensor_info(setting.id, "入力", "");
    }
  }
  if (g_target_count == 0) {
    g_settings_problem = true;
    Serial.println("[Node] 送るものがありません（センサーもポートも使わない設定です）");
  }
}

// 一覧に ID を足す。空の ID と、上限を超えた分は足さない
// 引数: id … 送る ID（例: "atom-b665-temp"）
// 戻り値: なし
void target_add(const String &id) {
  if (!id.isEmpty() && g_target_count < TARGET_MAX) {
    g_targets[g_target_count].id = id;
    g_target_count++;
  }
}

// 起動した時刻を覚え、どの ID も「起動したときに送れた」ことにする（起動から数えて、異常の基準の時間までは待つため）
// 引数: なし
// 戻り値: なし
void target_set_start() {
  g_start_ms = millis();
  for (int i = 0; i < g_target_count; i++) g_targets[i].ok_ms = g_start_ms;
}

// 起動してから、どれか 1つでも送れたか
// 引数: なし
// 戻り値: true = 送れた ID がある、false = まだ 1つも送れていない
bool target_any_sent() {
  for (int i = 0; i < g_target_count; i++) {
    if (g_targets[i].ok_ms != 0 && g_targets[i].ok_ms != g_start_ms) return true;
  }
  return false;
}

//****************************************************************
//  screen_ … 画面（M5Stack Basic だけ。文字は英数字だけ。日本語フォントは大きいので入れない）
//  画面に出す値（g_screen）は、画面のない機種でも send_・warning_ が書く（使わないだけ）
//****************************************************************

// 画面に出す値
struct ScreenStatus {
  bool warning = false;              // true = 異常（黄色の点滅と同じ）
  String problem;                    // 異常の理由（画面に出すので英数字。例: "ENV unit not found"）
  bool has_climate = false;          // true = 温度・湿度を読めた
  float temperature = 0;             // 温度 ℃（例: 23.4）
  float humidity = 0;                // 湿度 %（例: 45.0）
  bool has_pressure = false;         // true = 気圧を読めた
  float pressure = 0;                // 気圧 hPa（例: 1013.2）
};
ScreenStatus g_screen;   // send_・warning_ が書き、screen_status() が読む

#if HAS_SCREEN
const int SCREEN_WIDTH = 320;               // 画面の幅 ドット
const uint32_t SCREEN_INTERVAL_MS = 1000;   // 描き直しを調べる間隔 ミリ秒
const uint16_t COLOR_BLACK  = 0x0000;
const uint16_t COLOR_WHITE  = 0xFFFF;
const uint16_t COLOR_RED    = 0xC800;
const uint16_t COLOR_BLUE   = 0x041F;
const uint16_t COLOR_GREEN  = 0x0400;
const uint16_t COLOR_ORANGE = 0xFD20;
String g_last_drawn;   // 前回描いた内容。同じなら描き直さない（ちらつき防止）。WifiStarter から呼ばれる screen_event と loop の両方で使う

// 画面を始める（setup から 1回）
// 引数: なし
// 戻り値: なし
void screen_begin() {
  auto config = M5.config();
  M5.begin(config);   // 画面の電源とバックライトも入る
  M5.Display.setBrightness(120);
  M5.Display.fillScreen(COLOR_BLACK);
}

// 1行を、背景を塗ってから描く
// 引数: y      … 上の位置 ドット（0〜239）
//       height … 行の高さ ドット（例: 36）
//       text   … 描く文字（英数字）
//       font   … 文字の形（例: &fonts::FreeSans12pt7b）
//       color  … 文字の色（例: COLOR_WHITE）
//       back   … 背景の色（例: COLOR_BLACK）
// 戻り値: なし
void screen_line(int y, int height, const String &text, const lgfx::IFont *font, uint16_t color, uint16_t back) {
  M5.Display.fillRect(0, y, SCREEN_WIDTH, height, back);
  M5.Display.setFont(font);
  M5.Display.setTextColor(color, back);
  M5.Display.setTextDatum(textdatum_t::middle_left);
  M5.Display.drawString(text, 10, y + height / 2);
}

// WifiStarter の出来事を画面に出す（WifiStarter から呼ばれる。設定モードでは、つなぐ WiFi 名と設定画面のアドレスを出す）
// 引数: event  … 出来事（ButtonWait・SetupMode・ConnectingWifi・SettingsSaved）
//       first  … 1つ目の文字（設定モードは WiFi 名。例: "M5-Basic-Setup-b665"。接続中は SSID）
//       second … 2つ目の文字（設定モードは設定画面のアドレス。例: "http://192.168.100.1/"）
// 戻り値: なし
void screen_event(WifiStarterClass::Event event, const String &first, const String &second) {
  const lgfx::IFont *big = &fonts::FreeSansBold18pt7b;
  const lgfx::IFont *normal = &fonts::FreeSans12pt7b;
  g_last_drawn = "";
  M5.Display.fillScreen(COLOR_BLACK);
  if (event == WifiStarterClass::Event::ButtonWait) {
    screen_line(0, 36, "STARTING", big, COLOR_WHITE, COLOR_BLUE);
    screen_line(90, 36, "Press A", big, COLOR_WHITE, COLOR_BLACK);
    screen_line(130, 28, "for setup mode", normal, COLOR_WHITE, COLOR_BLACK);
  } else if (event == WifiStarterClass::Event::SetupMode) {
    screen_line(0, 36, "SETUP MODE", big, COLOR_WHITE, COLOR_RED);
    screen_line(56, 28, "Phone WiFi:", normal, COLOR_WHITE, COLOR_BLACK);
    screen_line(86, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE, COLOR_BLACK);
    screen_line(140, 28, "Open:", normal, COLOR_WHITE, COLOR_BLACK);
    screen_line(170, 32, second, &fonts::FreeSansBold9pt7b, COLOR_WHITE, COLOR_BLACK);
  } else if (event == WifiStarterClass::Event::ConnectingWifi) {
    screen_line(0, 36, "WIFI...", big, COLOR_WHITE, COLOR_BLUE);
    screen_line(90, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE, COLOR_BLACK);
  } else if (event == WifiStarterClass::Event::SettingsSaved) {
    screen_line(0, 36, "SAVED", big, COLOR_WHITE, COLOR_GREEN);
    screen_line(90, 36, "Restarting...", big, COLOR_WHITE, COLOR_BLACK);
  }
}

// 値の 1行を描く（名前は左、値は右寄せ）
// 引数: y         … 上の位置 ドット（例: 60）
//       label     … 名前（例: "TEMP"）
//       has_value … true = 値がある、false = "---" を出す
//       value     … 値（例: 23.4）
//       format    … 値の書き方（例: "%.1f C"）
// 戻り値: なし
void screen_value(int y, const char *label, bool has_value, float value, const char *format) {
  char text[32];
  if (has_value) snprintf(text, sizeof(text), format, value);
  else           snprintf(text, sizeof(text), "---");
  M5.Display.fillRect(0, y, SCREEN_WIDTH, 44, COLOR_BLACK);
  M5.Display.setFont(&fonts::FreeSans12pt7b);
  M5.Display.setTextColor(COLOR_WHITE, COLOR_BLACK);
  M5.Display.setTextDatum(textdatum_t::middle_left);
  M5.Display.drawString(label, 10, y + 22);
  M5.Display.setFont(&fonts::FreeSansBold18pt7b);
  M5.Display.setTextDatum(textdatum_t::middle_right);   // 桁が増えても、はみ出さない
  M5.Display.drawString(text, SCREEN_WIDTH - 8, y + 22);
}

// 動作中の表示: 状態の帯・温度・湿度・気圧（1秒ごとに調べ、変わったときだけ描く。loop から呼ぶ）
// 引数: なし
// 戻り値: なし
void screen_status() {
  static uint32_t last_ms = 0;   // 前に調べた時刻 ミリ秒
  if (millis() - last_ms < SCREEN_INTERVAL_MS) return;
  last_ms = millis();
  bool connected = WifiStarter.getState() == WifiState::Connected;
  const char *title = g_screen.warning ? "WARNING" : connected ? "RUNNING" : "WIFI...";
  uint16_t color = g_screen.warning ? COLOR_ORANGE : connected ? COLOR_GREEN : COLOR_BLUE;

  char text[96];   // 描く内容をまとめた文字（前回と同じか比べる）
  snprintf(text, sizeof(text), "%s|%.1f|%.1f|%.1f|%s", title, g_screen.has_climate ? g_screen.temperature : -999.0f,
           g_screen.has_climate ? g_screen.humidity : -999.0f, g_screen.has_pressure ? g_screen.pressure : -999.0f,
           g_screen.problem.c_str());
  if (g_last_drawn == text) return;
  // 別の画面から切り替わった最初は、全体を塗りつぶす（前の画面の文字が残らないように）
  if (g_last_drawn.isEmpty()) M5.Display.fillScreen(COLOR_BLACK);
  g_last_drawn = text;

  screen_line(0, 36, title, &fonts::FreeSansBold18pt7b, COLOR_WHITE, color);
  screen_value(60, "TEMP", g_screen.has_climate, g_screen.temperature, "%.1f C");
  screen_value(110, "HUMI", g_screen.has_climate, g_screen.humidity, "%.1f %%");
  screen_value(160, "PRES", g_screen.has_pressure, g_screen.pressure, "%.1f hPa");
  if (g_screen.warning && !g_screen.problem.isEmpty()) {
    screen_line(212, 26, g_screen.problem, &fonts::FreeSansBold9pt7b, COLOR_ORANGE, COLOR_BLACK);
  }
}
#else
// 画面のない機種では、何もしない（呼ぶ側を機種で分けないため）
// 引数・戻り値: 画面つきの機種の同じ名前の関数と同じ
void screen_begin() {}
void screen_event(WifiStarterClass::Event, const String &, const String &) {}
void screen_status() {}
#endif

//****************************************************************
//  server_ … サーバーに届くかの確認（原因の切り分け用。シリアルに出すだけ）
//****************************************************************
const uint32_t SERVER_CHECK_RETRY_MS = 120000;   // まだ 1つも送れていない間、確認をくり返す間隔 ミリ秒
const int SERVER_CHECK_WAIT_MS = 5000;           // 確認の返事を待つ時間 ミリ秒

// 起動後の最初と、まだ 1つも送れていない間は 2分ごとに、サーバーに届くかを確かめる（loop から呼ぶ）
// 引数: なし
// 戻り値: なし
void server_check() {
  static bool checked = false;    // 起動してから 1回でも確かめたか
  static uint32_t last_ms = 0;    // 前に確かめた時刻 ミリ秒
  if (!WifiStarter.isConnected()) return;
  if (checked && (target_any_sent() || millis() - last_ms <= SERVER_CHECK_RETRY_MS)) return;
  checked = true;
  last_ms = millis();
  server_health();
}

// サーバーの /health に GET して、結果をシリアルに出す
// 引数: なし
// 戻り値: なし
void server_health() {
  HTTPClient http;
  http.setConnectTimeout(SERVER_CHECK_WAIT_MS);
  http.setTimeout(SERVER_CHECK_WAIT_MS);
  http.begin(g_server_url + "/health");
  int code = http.GET();   // HTTP の番号（200 = 届いた。マイナス = 通信エラー）
  Serial.printf("[Node] サーバー確認 %s/health → %d%s  自分の IP=%s 電波=%d dBm\n", g_server_url.c_str(), code,
                code == 200 ? "（届いています）" : code < 0 ? "（届きません）" : "（届いたが想定外）",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  if (code < 0) Serial.printf("[Node]   理由: %s\n", HTTPClient::errorToString(code).c_str());
  http.end();
}

//****************************************************************
//  send_ … 送る（FactorEyeClient が ID ごとに POST する。溜まった分もまとめて送る。送れなかった分は溜めて再送する）
//****************************************************************
FactorEyeClient g_factoreye;   // FactorEye に送る部品。setup で始め、loop で送る

// 送る部品を始める（settings_read() の後に、setup から 1回）
// API キーは送る部品だけが使うので、ここで読む（設定 "apikey"。空なら X-API-Key を付けない）
// 引数: なし
// 戻り値: なし
void send_begin() {
  g_factoreye.begin(g_server_url, WifiStarter.setting("apikey"));
}

// FactorEye 側が自動登録（INGEST_AUTO_CREATE）のとき、この名前と単位でセンサーが作られる（登録済みなら無視される）
// 引数: id    … 送る ID（例: "atom-b665-temp"。空なら何もしない）
//       label … 名前の後ろに付ける言葉（例: "温度" → "atom-b665-temp 温度"）
//       unit  … 単位（例: "℃"。無ければ ""）
// 戻り値: なし
void send_sensor_info(const String &id, const char *label, const char *unit) {
  if (!id.isEmpty()) g_factoreye.setSensorInfo(id, id + " " + label, unit);
}

// 送る間隔ごとに、ENV とポート（デジタル・アナログ入力）を読んで送る（loop から呼ぶ）
// 引数: なし
// 戻り値: なし
void send_readings() {
  static uint32_t last_ms = 0;   // 前に送った時刻 ミリ秒
  if (!WifiStarter.isConnected() || millis() - last_ms < g_send_interval_ms) return;
  last_ms = millis();

  //****** ENV ******
  if (g_use_env && g_env_type != ENV_NONE) {
    float temperature, humidity, pressure;
    if (env_read_climate(temperature, humidity)) {
      g_screen.has_climate = ok_temp(temperature) && ok_hum(humidity);
      g_screen.temperature = temperature;
      g_screen.humidity = humidity;
      if (ok_temp(temperature)) send_value(g_id_temperature, temperature);   // ありえない値は送らない
      if (ok_hum(humidity))     send_value(g_id_humidity, humidity);
    }
    if (env_read_pressure(pressure) && ok_press(pressure)) {
      g_screen.has_pressure = true;
      g_screen.pressure = pressure;
      send_value(g_id_pressure, pressure);
    }
  }
  //****** ポート ******
  for (int i = 0; i < g_port_count; i++) {
    const PortSetting &setting = g_port_settings[i];
    int pin = setting.port->pin;
    if (setting.mode == PORT_DIN || setting.mode == PORT_DINPU) send_value(setting.id, digitalRead(pin));   // 0 / 1
    else if (setting.mode == PORT_AIN) send_value(setting.id, analogReadMilliVolts(pin) / 1000.0f);        // V
  }
}

// パルスのポート: 5秒ごとに、その間の個数（0 も送る）と、稼働（1/0）を送る（loop から呼ぶ）
// 引数: なし
// 戻り値: なし
void send_pulses() {
  static uint32_t last_ms = 0;   // 前に 5秒の区切りが来た時刻 ミリ秒
  if (millis() - last_ms < PULSE_WINDOW_MS) return;
  last_ms = millis();
  if (!WifiStarter.isConnected()) return;   // 切れている間は取り出さない（カウンタに残り、つながったら合計で送る）
  // 未送信が溜まっているときも取り出さない（個数が溜め場から押し出されないように）
  if (g_factoreye.pendingCount() >= PULSE_BUFFER_GUARD) return;
  for (int i = 0; i < g_port_count; i++) {
    PortSetting &setting = g_port_settings[i];
    if (setting.mode != PORT_PULSE) continue;
    send_value(setting.id, (float)pulse_take(&setting.pulse));
    if (!setting.run_id.isEmpty()) {
      bool by_time = run_by_time(pulse_last_ms(&setting.pulse), millis(), setting.stop_ms);
      send_value(setting.run_id, is_running(by_time, setting.external_signal) ? 1.0f : 0.0f);
    }
  }
}

// 1つの値を送る。送れたら、その ID の「最後に送れた時刻」を新しくする
// 引数: id    … 送る ID（例: "atom-b665-temp"。空なら送らない）
//       value … 値（例: 23.4）
// 戻り値: true = 送れた、false = 送れない（FactorEyeClient が、たいていは溜めて、あとで再送する。400・422 などは捨てる）
bool send_value(const String &id, float value) {
  if (id.isEmpty()) return false;
  bool sent = g_factoreye.send(id, value);
  if (sent) {
    for (int i = 0; i < g_target_count; i++) {
      if (g_targets[i].id == id) g_targets[i].ok_ms = millis();
    }
  }
  Serial.printf("[Node] %s = %.2f  %s\n", id.c_str(), value, sent ? "送信OK" : "送信できず（溜めて再送します）");
  return sent;
}

//****************************************************************
//  warning_ … 異常の LED（黄色の点滅）
//****************************************************************

// 異常かを調べて、LED（黄色の点滅）と画面に出す値を決める（loop から呼ぶ）
// 異常: 設定の問題 / センサーが無い / どれかの ID が「間隔の3倍（最短2分）」たっても送れていない
// 引数: なし
// 戻り値: なし
void warning_update() {
  bool sensor_missing = g_use_env && g_env_type == ENV_NONE;
  bool send_stalled = any_stalled(g_targets, g_target_count, millis(), fail_limit_ms(g_send_interval_ms));
  g_screen.warning = g_settings_problem || sensor_missing || send_stalled;
  WifiStarter.setWarning(g_screen.warning);
  // 画面に出す文字なので英数字
  if (g_settings_problem)  g_screen.problem = "Check settings (server)";
  else if (sensor_missing) g_screen.problem = "ENV unit not found";
  else if (send_stalled)   g_screen.problem = "Cannot send data";
  else                     g_screen.problem = "";
}

//****************************************************************
//  power_ … 電源を保つ（M5StickC Plus2 だけ。ほかの機種は POWER_HOLD_PIN が -1 で何もしない）
//****************************************************************

// 電池で動かすとき、電源を保つピンを HIGH にする（setup のいちばん最初に呼ぶ）
// 引数: なし
// 戻り値: なし
void power_keep_on() {
  if (POWER_HOLD_PIN < 0) return;
  pinMode(POWER_HOLD_PIN, OUTPUT);
  digitalWrite(POWER_HOLD_PIN, HIGH);
}

//****************************************************************
//  wifi_ … WiFi
//****************************************************************

// WiFi につなぐ（ボタンを押しながら起動したとき・必須の設定が未入力のときは、設定モードに入る）
//   ふつうの起動 … 保存してある WiFi につなぎにいき、すぐ戻る（つながるのを待たない）
//                  つながったか・切れたらつなぎ直すかは、loop の WifiStarter.loop() が見る
//   設定モード   … 本体が WiFi「M5-ATOMLite-Setup-XXXX」などを出すので、スマホでつないで設定する（保存すると再起動）
//                  ここで止まって戻らない
// 引数: なし
// 戻り値: なし
void wifi_start() {
  WifiStarter.onEvent(screen_event);   // 設定モードなどの出来事を画面に出す（画面のない機種では何もしない）
  settings_items();                    // 設定画面に出す項目を登録する（センサー・送り先・書き込む ID・ポート）

  // 機種ごとの値（node_calc.h の「機種ごとのピン」）を、WifiStarter に渡す入れ物に写す
  WifiStarterConfig config;
  config.buttonPin = BTN_PIN;            // 押しながら電源ON で設定モード
  config.ledPin = LED_PIN;               // 状態を出す LED（無い機種は -1）
  config.ledPowerPin = LED_POWER_PIN;    // LED の電源ピン（NanoC6 は G19。無い機種は -1）
  config.ledIsMono = LED_MONO;           // true = 1色の LED（点滅のしかたで状態を出す。M5StickC）
  config.ledActiveLow = LED_LOW;         // true = LOW で光る LED
  config.buttonWaitMs = BTN_WAIT_MS;     // 起動後にボタンを待つ時間 ミリ秒（0 = 起動の瞬間だけ見る）
  config.apNamePrefix = AP_NAME;         // 設定モードの WiFi の名前の頭（例: M5-NanoC6-Setup → M5-NanoC6-Setup-2449）
  WifiStarter.begin(config);   // ここで WiFi につなぎにいく（設定モードのときは、ここで止まる）
}

//****************************************************************
//  setup()・loop()
//****************************************************************
void setup() {
  power_keep_on();               // 電池で動かすとき、電源を保つ（StickC Plus2）
  Serial.begin(115200);
  screen_begin();                // 画面を始める（M5Stack Basic だけ）
  wifi_start();                  // WiFi（設定モードのときは、ここで止まる）
  settings_read();               // 保存した設定を読む（センサー・書き込む ID・送る間隔・送り先）
  send_begin();                  // 送る部品を始める（送り先・API キー）
  port_start();                  // 使うポートのピンを用意する（パルスは割り込みで数え始める）
  target_make();                 // 送る ID の一覧を作る（異常の判断に使う）
  env_begin();                   // ENV を探して始める（見つからなければ loop でやり直す）
  target_set_start();            // 起動した時刻を覚える（異常の基準の時間までは待つ）
  Serial.printf("[Node] %s / センサー=%s / 間隔=%lu 秒 / ポート %d 個\n", BOARD_NAME, g_use_env ? "auto" : "none",
                g_send_interval_ms / 1000, g_port_count);
}

void loop() {
  WifiStarter.loop();            // WiFi のつなぎ直し・LED
  env_retry();                   // ENV が見つからないときは、30秒ごとにやり直す
  server_check();                // 起動後の最初と、まだ送れていない間は 2分ごとに、サーバーに届くかを確かめる
  send_readings();               // 送る間隔ごとに、ENV とポートを読んで送る
  send_pulses();                 // 5秒ごとに、パルスの個数と稼働（1/0）を送る
  warning_update();              // 異常なら黄色の点滅
  screen_status();               // 画面を描き直す（M5Stack Basic だけ）
}
