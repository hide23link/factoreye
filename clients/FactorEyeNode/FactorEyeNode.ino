/* FactorEyeNode  M5Stack（ATOM Lite など）の ENV センサーと入出力ポートの値を、FactorEye に送る
 *  使い方は README.md、仕様の詳細は SPEC.md
 *
 *  設定はすべてスマホの設定画面で行う（書き込み直さなくてよい）
 *    ボタンを押しながら電源を入れる、または必須の設定が未入力 → 設定モード（赤点滅）
 *    センサーの種類・送り先・書き込む ID・入出力ポートを入れて保存 → 再起動して送り始める
 *  WiFi の設定と接続は WifiStarter（src/WifiStarter/、同梱）が行う
 *  LED: 赤点滅=設定モード 青点滅=WiFi に接続中 青点灯=動作中 黄色の点滅=異常（センサーが無い・送信が続けて失敗）
 *  流れ（loop）: 間隔が来たら、センサーとポートを読んで送る（FactorEyeClient。失敗した分は溜めて再送）
 *               パルスのポートは、5秒ごとに個数と稼働（1/0）を送る
 */
#include <FactorEyeClient.h>
#include <HTTPClient.h>
#include <WiFi.h>
#include <Wire.h>
#include <esp_mac.h>
#include <M5UnitENV.h>                     // ENVユニット（SHT30・SHT40・QMP6988・BMP280）
#include "src/WifiStarter/WifiStarter.h"   // WiFi 設定・接続（同梱）
#include "node_calc.h"                     // 機種ごとのピン・設定の決まり・パルスの数え方
#if HAS_SCREEN
#include <M5Unified.h>                     // 画面つきの機種（M5Stack Basic）だけ
#endif

#define I2C_SPEED      400000
#define SENSOR_RETRY   30000    // ENV が見つからないとき、つなぎ直す間隔
#define PROBE_RETRY    120000   // まだ1つも送れていない間、サーバー確認をくり返す間隔
#define TARGET_MAX     12

FactorEyeClient factoreye;

String sensor_type;      // "auto"（ENV2・ENV3・ENV4 を自動で見分ける）/ "none"
String id_temp;          // 書き込む ID（空なら送らない）
String id_hum;
String id_press;
unsigned long send_interval = 30000;
String server_address;
bool settings_problem = false;   // サーバーアドレスが正しくない・送るものがない（黄色の点滅で知らせる）

//****** ポート1つ分の設定（保存した値から作る） ******
struct PORT_SET {
  const PORT_INFO *info;
  int mode;               // PORT_OFF〜PORT_DOUT
  String id;              // 書き込む ID（パルスのときは個数）
  PULSE counter;          // パルスのときだけ使う（割り込みで数える）
  String run_id;          // 稼働（1/0）を送る ID。空なら送らない
  unsigned long stop_ms;  // 停止とみなす時間
  int external;           // 外部の稼働・停止の信号（いまは常に RUN_UNKNOWN）
};
PORT_SET port_sets[8];
int port_set_count = 0;

SEND_TARGET targets[16];  // 送る ID ごとの、最後に送れた時刻
int target_count = 0;

unsigned long send_ms = 0;
unsigned long pulse_ms = 0;
unsigned long start_ms = 0;
unsigned long sensor_try_ms = 0;
unsigned long probe_ms = 0;
bool probed = false;

//****** 画面に出す内容（画面のない機種では使わない） ******
struct NODE_STATUS {
  WifiState wifi = WifiState::Connecting;
  bool warning = false;
  String problem;          // 異常の理由（画面に出すので英数字）
  bool has_climate = false;
  float tmp = 0;
  float hum = 0;
  bool has_press = false;
  float pressure = 0;
};
NODE_STATUS status;
unsigned long screen_ms = 0;

//****************************************************************
//  ENV ユニット（ENV2・ENV3・ENV4 を自動で見分ける）
//****************************************************************
#define ENV_NONE  0
#define ENV2      2   // SHT30 + BMP280
#define ENV3      3   // SHT30 + QMP6988
#define ENV4      4   // SHT40 + BMP280

SHT3X sht30;
SHT4X sht40;
QMP6988 qmp6988;
BMP280 bmp280;
int env_kind = ENV_NONE;   // 使える ENV（見つからなければ ENV_NONE）

bool i2c_answer(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

// シリアル番号を読むコマンドを送り、CRC の合う応答が返るか（3回まで試す）
// SHT40 は 0x89、SHT30 は 0x37 0x80 に答える（相手のコマンドには、まともに答えない）
bool sht_answer(const uint8_t *cmd, int len) {
  for (int n = 0; n < 3; n++) {
    Wire.beginTransmission(0x44);
    Wire.write(cmd, len);
    if (Wire.endTransmission() != 0) continue;
    delay(5);
    if (Wire.requestFrom((uint8_t)0x44, (uint8_t)6) != 6) continue;
    uint8_t b[6];
    for (int i = 0; i < 6; i++) b[i] = Wire.read();
    if (sht_serial_ok(b)) return true;
  }
  return false;
}

int env_check() {
  const uint8_t sht40_cmd[] = {0x89};
  const uint8_t sht30_cmd[] = {0x37, 0x80};
  Wire.begin(I2C_SDA, I2C_SCL, I2C_SPEED);
  bool sht = i2c_answer(0x44);   // SHT30・SHT40（同じアドレス）
  bool qmp = i2c_answer(0x70);   // QMP6988（ENV3）
  bool bmp = i2c_answer(0x76);   // BMP280（ENV2・ENV4）
  Serial.printf("[ENV] I2C の応答: SHT(0x44)=%s QMP6988(0x70)=%s BMP280(0x76)=%s\n",
                sht ? "あり" : "なし", qmp ? "あり" : "なし", bmp ? "あり" : "なし");
  if (!sht) return ENV_NONE;
  if (qmp) return ENV3;
  if (!bmp) return ENV_NONE;
  if (sht_answer(sht40_cmd, 1)) return ENV4;
  if (sht_answer(sht30_cmd, 2)) return ENV2;
  // どちらも確かめられない → SHT40 の応答が一時的に乱れたことが多いので ENV4 とみなす
  Serial.println("[ENV] 温湿度センサーの種類を確かめられませんでした。ENV4 とみなします");
  return ENV4;
}

// ENV を使えるようにする。見つからないときは false（あとでやり直す）
bool start_sensor() {
  if (sensor_type == "none") return true;
  env_kind = env_check();
  if (env_kind == ENV_NONE) return false;
  Serial.printf("[ENV] 自動判別: ENV%d\n", env_kind);
  bool ok1, ok2;
  if (env_kind == ENV4) ok1 = sht40.begin(&Wire, SHT40_I2C_ADDR_44, I2C_SDA, I2C_SCL, I2C_SPEED);
  else                  ok1 = sht30.begin(&Wire, SHT3X_I2C_ADDR, I2C_SDA, I2C_SCL, I2C_SPEED);
  if (env_kind == ENV3) ok2 = qmp6988.begin(&Wire, QMP6988_SLAVE_ADDRESS_L, I2C_SDA, I2C_SCL, I2C_SPEED);
  else                  ok2 = bmp280.begin(&Wire, BMP280_I2C_ADDR, I2C_SDA, I2C_SCL, I2C_SPEED);
  if (ok1 && ok2 && env_kind != ENV3) {
    // BMP280 の標準の設定（M5 のサンプルと同じ）
    bmp280.setSampling(BMP280::MODE_NORMAL, BMP280::SAMPLING_X2, BMP280::SAMPLING_X16,
                       BMP280::FILTER_X16, BMP280::STANDBY_MS_500);
  }
  Serial.printf("[ENV] ENV%d 温湿度=%s 気圧=%s\n", env_kind, ok1 ? "OK" : "見つからない", ok2 ? "OK" : "見つからない");
  if (!ok1 || !ok2) env_kind = ENV_NONE;
  return env_kind != ENV_NONE;
}

bool env_read_climate(float *t, float *h) {
  if (env_kind == ENV4) {
    if (!sht40.update()) return false;
    *t = sht40.cTemp;
    *h = sht40.humidity;
    return true;
  }
  if (env_kind == ENV_NONE || !sht30.update()) return false;
  *t = sht30.cTemp;
  *h = sht30.humidity;
  return true;
}

bool env_read_pressure(float *p) {
  if (env_kind == ENV3) {
    if (!qmp6988.update()) return false;
    *p = qmp6988.pressure / 100.0;   // Pa → hPa
    return true;
  }
  if (env_kind == ENV_NONE || !bmp280.update()) return false;
  *p = bmp280.pressure / 100.0;
  return true;
}

//****************************************************************
//  設定画面
//****************************************************************
// この本体の識別（設定モードの WiFi 名と同じ、MAC の下4桁）。ID の初期値を台ごとに変えるため
String device_suffix() {
  uint8_t mac[6];
  char text[5];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  snprintf(text, sizeof(text), "%02x%02x", mac[4], mac[5]);
  return text;
}

// 設定画面の項目（WifiStarter.begin() の前に登録する）
void setting_items() {
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
  String head = String(ID_PREFIX) + "-" + device_suffix() + "-";
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
    String mode_key = port_key(port.name, "mode");
    String pulse_only = mode_key + "=pulse";   // パルスを数えるときだけ表示
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

// パルスの割り込み。数えるだけ（Serial・String・HTTP は使わない）
void IRAM_ATTR pulse_isr(void *arg) {
  pulse_edge((PULSE *)arg, micros(), millis());
}

// 送り先の一覧に足す（異常の判断に使う）。空の ID は足さない
void add_target(const String &id) {
  if (!id.isEmpty() && target_count < TARGET_MAX) targets[target_count++].id = id;
}

// FactorEye 側が自動登録（INGEST_AUTO_CREATE）のとき、この名前と単位でセンサーが作られる（登録済みなら無視される）
void describe(const String &id, const char *label, const char *unit) {
  if (!id.isEmpty()) factoreye.setSensorInfo(id, id + " " + label, unit);
}

// 保存した設定を読み、ポートを使える状態にする
void apply_settings() {
  sensor_type = WifiStarter.setting("sensor");
  if (sensor_type != "none") sensor_type = "auto";   // 以前の版の ENV2・ENV3・ENV4 も自動として扱う
  id_temp = WifiStarter.setting("id_temp");
  id_hum = WifiStarter.setting("id_humi");
  id_press = WifiStarter.setting("id_press");
  send_interval = interval_ms(WifiStarter.settingInt("interval", 30));

  server_address = clean_address(WifiStarter.setting("server"));
  settings_problem = !http_address(server_address);
  if (settings_problem) Serial.println("[Node] サーバーアドレスは http:// で始めてください（送信できません）");
  factoreye.begin(server_address, WifiStarter.setting("apikey"));

  //****** ポート ******
  port_set_count = 0;
  for (int i = 0; i < PORT_COUNT && port_set_count < 8; i++) {
    const PORT_INFO &port = PORTS[i];
    PORT_SET &ps = port_sets[port_set_count];
    ps.info = &port;
    ps.mode = parse_port_mode(WifiStarter.setting(port_key(port.name, "mode")));
    ps.id = WifiStarter.setting(port_key(port.name, "id"));
    ps.run_id = WifiStarter.setting(port_key(port.name, "idrun"));
    ps.stop_ms = 0;
    ps.external = RUN_UNKNOWN;
    if (ps.mode == PORT_OFF) continue;
    port_set_count++;

    if (ps.mode == PORT_PULSE) {
      bool on_low = on_level_low(WifiStarter.setting(port_key(port.name, "lvl")));
      long deb_ms = WifiStarter.settingInt(port_key(port.name, "deb"), PULSE_DEB_DEFAULT);
      long stop_sec = WifiStarter.settingInt(port_key(port.name, "stop"), PULSE_STOP_DEFAULT);
      ps.stop_ms = (unsigned long)stop_sec * 1000UL;
      pinMode(port.pin, (on_low && !port.input_only) ? INPUT_PULLUP : INPUT);   // 入力専用（G34〜G39）は内部プルアップなし
      pulse_begin(&ps.counter, (uint32_t)deb_ms * 1000UL, millis());
      attachInterruptArg(digitalPinToInterrupt(port.pin), pulse_isr, &ps.counter, on_low ? FALLING : RISING);
    } else if (ps.mode == PORT_DINPU) {
      pinMode(port.pin, INPUT_PULLUP);
    } else if (ps.mode == PORT_DOUT) {
      pinMode(port.pin, OUTPUT);   // 出力の使い方は今後追加
      digitalWrite(port.pin, LOW);
    } else {
      pinMode(port.pin, INPUT);    // デジタル入力・アナログ入力
    }
  }

  //****** 送り先の一覧と、センサーの名前・単位 ******
  target_count = 0;
  if (sensor_type != "none") {
    add_target(id_temp);
    add_target(id_hum);
    add_target(id_press);
    describe(id_temp, "温度", "℃");
    describe(id_hum, "湿度", "%");
    describe(id_press, "気圧", "hPa");
  }
  for (int i = 0; i < port_set_count; i++) {
    PORT_SET &ps = port_sets[i];
    if (ps.mode != PORT_DOUT) add_target(ps.id);
    if (ps.mode == PORT_PULSE) {
      add_target(ps.run_id);
      describe(ps.id, "生産数", "個");
      describe(ps.run_id, "稼働", "");
    } else if (ps.mode == PORT_AIN) {
      describe(ps.id, "入力", "V");
    } else if (ps.mode == PORT_DIN || ps.mode == PORT_DINPU) {
      describe(ps.id, "入力", "");
    }
  }
  if (target_count == 0) {
    settings_problem = true;
    Serial.println("[Node] 送るものがありません（センサーもポートも使わない設定です）");
  }
}

//****************************************************************
//  送信
//****************************************************************
// ID が決まっている値だけ送る。送れたら、その ID の「最後に送れた時刻」を更新する
bool send_value(const String &id, float value) {
  if (id.isEmpty()) return false;
  bool sent = factoreye.send(id, value);
  if (sent) {
    for (int i = 0; i < target_count; i++) {
      if (targets[i].id == id) targets[i].ok_ms = millis();
    }
  }
  Serial.printf("[Node] %s = %.2f  %s\n", id.c_str(), value, sent ? "送信OK" : "送信できず（溜めて再送します）");
  return sent;
}

// 1回分: センサーとポートを読んで送る
void read_and_send() {
  if (sensor_type != "none" && env_kind != ENV_NONE) {
    float t, h, p;
    if (env_read_climate(&t, &h)) {
      status.has_climate = ok_temp(t) && ok_hum(h);
      status.tmp = t;
      status.hum = h;
      if (ok_temp(t)) send_value(id_temp, t);
      if (ok_hum(h))  send_value(id_hum, h);
    }
    if (env_read_pressure(&p) && ok_press(p)) {
      status.has_press = true;
      status.pressure = p;
      send_value(id_press, p);
    }
  }
  for (int i = 0; i < port_set_count; i++) {
    const PORT_SET &ps = port_sets[i];
    if (ps.mode == PORT_DIN || ps.mode == PORT_DINPU) send_value(ps.id, digitalRead(ps.info->pin));
    else if (ps.mode == PORT_AIN) send_value(ps.id, analogReadMilliVolts(ps.info->pin) / 1000.0f);   // V
  }
}

// パルスのポート: 5秒ごとに、その間の個数（0も）と稼働（1/0）を送る
void send_pulses() {
  if (millis() - pulse_ms < PULSE_WINDOW_MS) return;
  pulse_ms = millis();
  if (!WifiStarter.isConnected()) return;   // 切れている間は取り出さない（カウンタに残り、つながったら合計で送る）
  // 未送信が溜まっているときも取り出さない（個数が溜め場から押し出されないように）
  if (factoreye.pendingCount() >= PULSE_BUFFER_GUARD) return;
  for (int i = 0; i < port_set_count; i++) {
    PORT_SET &ps = port_sets[i];
    if (ps.mode != PORT_PULSE) continue;
    send_value(ps.id, (float)pulse_take(&ps.counter));
    if (!ps.run_id.isEmpty()) {
      bool by_time = run_by_time(pulse_last_ms(&ps.counter), millis(), ps.stop_ms);
      send_value(ps.run_id, is_running(by_time, ps.external) ? 1.0f : 0.0f);
    }
  }
}

// サーバーに届くかを確かめて、シリアルに出す（原因の切り分け用）
void probe_server() {
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  http.begin(server_address + "/health");
  int code = http.GET();
  Serial.printf("[Node] サーバー確認 %s/health → %d%s  自分の IP=%s 電波=%d dBm\n", server_address.c_str(), code,
                code == 200 ? "（届いています）" : code < 0 ? "（届きません）" : "（届いたが想定外）",
                WiFi.localIP().toString().c_str(), WiFi.RSSI());
  if (code < 0) Serial.printf("[Node]   理由: %s\n", HTTPClient::errorToString(code).c_str());
  http.end();
}

// 起動してから、どれか1つでも送れたか
bool any_sent() {
  for (int i = 0; i < target_count; i++) {
    if (targets[i].ok_ms != 0 && targets[i].ok_ms != start_ms) return true;
  }
  return false;
}

// 黄色の点滅で知らせる異常: 設定の問題 / センサーが無い / どれかの ID が長く送れていない
void update_warning() {
  bool sensor_missing = sensor_type != "none" && env_kind == ENV_NONE;
  bool send_stalled = any_stalled(targets, target_count, millis(), fail_limit_ms(send_interval));
  status.warning = settings_problem || sensor_missing || send_stalled;
  WifiStarter.setWarning(status.warning);
  // 画面に出す文字なので英数字
  if (settings_problem)    status.problem = "Check settings (server)";
  else if (sensor_missing) status.problem = "ENV unit not found";
  else if (send_stalled)   status.problem = "Cannot send data";
  else                     status.problem = "";
}

//****************************************************************
//  画面（M5Stack Basic だけ。文字は英数字だけ。日本語フォントは大きいので入れない）
//****************************************************************
#if HAS_SCREEN
#define SCREEN_W      320
#define COLOR_BLACK   0x0000
#define COLOR_WHITE   0xFFFF
#define COLOR_RED     0xC800
#define COLOR_BLUE    0x041F
#define COLOR_GREEN   0x0400
#define COLOR_ORANGE  0xFD20
String last_drawn;   // 前回描いた内容。同じなら描き直さない（ちらつき防止）

void screen_begin() {
  auto config = M5.config();
  M5.begin(config);   // 画面の電源とバックライトも入る
  M5.Display.setBrightness(120);
  M5.Display.fillScreen(COLOR_BLACK);
}

// 1行を、背景を塗ってから描く
void screen_line(int y, int height, const String &text, const lgfx::IFont *font, uint16_t color, uint16_t back = COLOR_BLACK) {
  M5.Display.fillRect(0, y, SCREEN_W, height, back);
  M5.Display.setFont(font);
  M5.Display.setTextColor(color, back);
  M5.Display.setTextDatum(textdatum_t::middle_left);
  M5.Display.drawString(text, 10, y + height / 2);
}

// WifiStarter の出来事（設定モードでは、つなぐ WiFi 名と設定画面のアドレスを出す）
void screen_event(WifiStarterClass::Event event, const String &first, const String &second) {
  const lgfx::IFont *big = &fonts::FreeSansBold18pt7b;
  const lgfx::IFont *normal = &fonts::FreeSans12pt7b;
  last_drawn = "";
  M5.Display.fillScreen(COLOR_BLACK);
  if (event == WifiStarterClass::Event::ButtonWait) {
    screen_line(0, 36, "STARTING", big, COLOR_WHITE, COLOR_BLUE);
    screen_line(90, 36, "Press A", big, COLOR_WHITE);
    screen_line(130, 28, "for setup mode", normal, COLOR_WHITE);
  } else if (event == WifiStarterClass::Event::SetupMode) {
    screen_line(0, 36, "SETUP MODE", big, COLOR_WHITE, COLOR_RED);
    screen_line(56, 28, "Phone WiFi:", normal, COLOR_WHITE);
    screen_line(86, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE);
    screen_line(140, 28, "Open:", normal, COLOR_WHITE);
    screen_line(170, 32, second, &fonts::FreeSansBold9pt7b, COLOR_WHITE);
  } else if (event == WifiStarterClass::Event::ConnectingWifi) {
    screen_line(0, 36, "WIFI...", big, COLOR_WHITE, COLOR_BLUE);
    screen_line(90, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE);
  } else if (event == WifiStarterClass::Event::SettingsSaved) {
    screen_line(0, 36, "SAVED", big, COLOR_WHITE, COLOR_GREEN);
    screen_line(90, 36, "Restarting...", big, COLOR_WHITE);
  }
}

// 値の1行（名前は左、値は右寄せ）
void screen_value(int y, const char *label, bool has, float value, const char *format) {
  char buf[32];
  if (has) snprintf(buf, sizeof(buf), format, value);
  else     snprintf(buf, sizeof(buf), "---");
  M5.Display.fillRect(0, y, SCREEN_W, 44, COLOR_BLACK);
  M5.Display.setFont(&fonts::FreeSans12pt7b);
  M5.Display.setTextColor(COLOR_WHITE, COLOR_BLACK);
  M5.Display.setTextDatum(textdatum_t::middle_left);
  M5.Display.drawString(label, 10, y + 22);
  M5.Display.setFont(&fonts::FreeSansBold18pt7b);
  M5.Display.setTextDatum(textdatum_t::middle_right);   // 桁が増えても、はみ出さない
  M5.Display.drawString(buf, SCREEN_W - 8, y + 22);
}

// 動作中の表示: 状態の帯・温度・湿度・気圧（1秒ごと）
void screen_status() {
  if (millis() - screen_ms < 1000) return;
  screen_ms = millis();
  status.wifi = WifiStarter.getState();
  bool connected = status.wifi == WifiState::Connected;
  const char *title = status.warning ? "WARNING" : connected ? "RUNNING" : "WIFI...";
  uint16_t color = status.warning ? COLOR_ORANGE : connected ? COLOR_GREEN : COLOR_BLUE;

  char text[96];
  snprintf(text, sizeof(text), "%s|%.1f|%.1f|%.1f|%s", title, status.has_climate ? status.tmp : -999.0f,
           status.has_climate ? status.hum : -999.0f, status.has_press ? status.pressure : -999.0f, status.problem.c_str());
  if (last_drawn == text) return;
  // 別の画面から切り替わった最初は、全体を塗りつぶす（前の画面の文字が残らないように）
  if (last_drawn.isEmpty()) M5.Display.fillScreen(COLOR_BLACK);
  last_drawn = text;

  screen_line(0, 36, title, &fonts::FreeSansBold18pt7b, COLOR_WHITE, color);
  screen_value(60, "TEMP", status.has_climate, status.tmp, "%.1f C");
  screen_value(110, "HUMI", status.has_climate, status.hum, "%.1f %%");
  screen_value(160, "PRES", status.has_press, status.pressure, "%.1f hPa");
  if (status.warning && !status.problem.isEmpty()) screen_line(212, 26, status.problem, &fonts::FreeSansBold9pt7b, COLOR_ORANGE);
}
#else
void screen_begin() {}
void screen_event(WifiStarterClass::Event, const String &, const String &) {}
void screen_status() {}
#endif

//****************************************************************
void setup() {
  if (POWER_HOLD_PIN >= 0) {   // 電池で動かすとき、電源を保つ（StickC Plus2）
    pinMode(POWER_HOLD_PIN, OUTPUT);
    digitalWrite(POWER_HOLD_PIN, HIGH);
  }
  Serial.begin(115200);
  screen_begin();
  WifiStarter.onEvent(screen_event);
  setting_items();

  WifiStarterConfig config;
  config.buttonPin = BTN_PIN;
  config.ledPin = LED_PIN;
  config.ledPowerPin = LED_POWER_PIN;
  config.ledIsMono = LED_MONO;
  config.ledActiveLow = LED_LOW;
  config.buttonWaitMs = BTN_WAIT_MS;
  config.apNamePrefix = AP_NAME;   // 例: M5-NanoC6-Setup-2449（機種が分かる名前）
  WifiStarter.begin(config);       // 設定モードのときは、ここで止まる

  apply_settings();
  start_sensor();
  start_ms = millis();
  for (int i = 0; i < target_count; i++) targets[i].ok_ms = start_ms;   // 起動から数えて、基準の時間までは待つ
  Serial.printf("[Node] %s / センサー=%s / 間隔=%lu 秒 / ポート %d 個\n", BOARD_NAME, sensor_type.c_str(),
                send_interval / 1000, port_set_count);
}

void loop() {
  WifiStarter.loop();   // WiFi のつなぎ直し・LED

  //****** ENV が見つからないときは、30秒ごとにやり直す（あとから挿したとき） ******
  if (sensor_type != "none" && env_kind == ENV_NONE && millis() - sensor_try_ms > SENSOR_RETRY) {
    sensor_try_ms = millis();
    start_sensor();
  }

  //****** サーバー確認（起動後の最初と、まだ1つも送れていない間は2分ごと） ******
  if (WifiStarter.isConnected() && (!probed || (!any_sent() && millis() - probe_ms > PROBE_RETRY))) {
    probed = true;
    probe_ms = millis();
    probe_server();
  }

  //****** 送る ******
  if (WifiStarter.isConnected() && millis() - send_ms >= send_interval) {
    send_ms = millis();
    read_and_send();
  }
  send_pulses();
  update_warning();
  screen_status();
}
