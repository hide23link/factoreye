// FactorEyeNode — M5Stack（ATOM Lite など）の ENV センサーと入出力ポートの値を、FactorEye に送る。
//
// 設定はすべてスマホの設定画面で行う（書き込み直さなくてよい）:
//   ボタンを押しながら電源を入れる、または必須の設定が未入力のとき → 設定モード（赤点滅）
//   設定画面で、センサーの種類・送り先・書き込む ID・入出力ポートを入れて保存 → 再起動して送信を始める
// WiFi の設定と接続は WifiStarter（src/WifiStarter/、同梱）が行う（保存済みの WiFi は、そのまま引き継ぐ）。
//
// LED: 赤点滅 = 設定モード / 青点滅 = WiFi に接続中 / 青点灯 = 動作中 / 黄色の点滅 = 異常
//      （センサーが見つからない、または送信が続けて失敗している）
//
// 処理の流れ（loop）: WiFi が切れていれば何もしない（つなぎ直しは WifiStarter が行う）
//   → 間隔が来たら、センサーとポートを読んで FactorEye に送る（FactorEyeClient。失敗した分は溜めて再送）
// 使い方は README.md、仕様の詳細は SPEC.md。
#include <FactorEyeClient.h>
#include <HTTPClient.h>
#include <WiFi.h>

#include "Boards.h"
#include "EnvSensor.h"
#include "NodeConfig.h"
#include "PulseCounter.h"
#include "RunJudge.h"
#include "StatusScreen.h"

#include <esp_mac.h>

#include "src/WifiStarter/WifiStarter.h"  // WiFi 設定・接続のライブラリ（同梱）

FactorEyeClient factoreye;
EnvSensor envSensor;

String sensorType;      // "auto"（ENV2・ENV3・ENV4 を自動で見分ける）/ "none"
String idTemperature;   // 書き込む ID（空なら、その値は送らない）
String idHumidity;
String idPressure;
unsigned long sendIntervalMs = 30000;

// ポート 1 つ分の設定（保存した値から作る）
struct PortSetting {
  const PortInfo* info;
  PortMode mode;
  String ingestId;  // パルスのときは、個数を送る ID（生産数 ID）
  // ここから、パルスを数えるポートだけ使う
  PulseCounter counter;                       // 割り込みで数える（PulseCounter.h）
  String runId;                               // 稼働・停止（1/0）を送る ID。空なら送らない
  unsigned long stopMs = 0;                   // 停止とみなす時間（ミリ秒）
  ExternalRun external = ExternalRun::Unknown;  // 外部の稼働・停止の信号（いまは、常に「不明」。RunJudge.h）
};
PortSetting portSettings[8];
size_t portSettingCount = 0;

SendTarget targets[16];  // 送る ID ごとの、最後に送れた時刻
size_t targetCount = 0;
bool settingsProblem = false;  // サーバーアドレスが正しくない・送るものがない、など（黄色の点滅で知らせる）

String serverAddress;  // 整形したサーバーアドレス
unsigned long lastProbeMs = 0;
bool probedOnce = false;

NodeStatus status;  // 画面に出す内容（画面のない機種では使わない）
unsigned long lastScreenMs = 0;

unsigned long lastSendMs = 0;
unsigned long lastPulseWindowMs = 0;
unsigned long startMs = 0;
unsigned long lastSensorRetryMs = 0;

// 台ごとに違う ID の初期値を作るための、この本体の識別（アクセスポイントの MAC の下 4 桁。設定モードの SSID と同じ）
String deviceSuffix() {
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  char text[5];
  snprintf(text, sizeof(text), "%02x%02x", mac[4], mac[5]);
  return text;
}

// 設定画面の項目を登録する（WifiStarter.begin() より前に呼ぶ）
void registerSettings() {
  WifiStarter.setTitle("センサーノード設定");

  WifiStarter.addGroup("② センサー");
  // ENV ユニット（ENV2・ENV3・ENV4）は自動で見分ける。以前の版で保存した ENV2・ENV3・ENV4 の値も、自動として扱う
  WifiStarter.addSelect("sensor", "ENV ユニット（Grove）", "auto=自動で見分ける（ENV2・ENV3・ENV4）|none=つながない（ポートだけ使う）", "auto")
      .help(String("Grove: SDA G") + BOARD.sdaPin + " / SCL G" + BOARD.sclPin + "。温度・湿度・気圧を読みます。ユニットを差し替えても、設定は変えなくてよい");

  WifiStarter.addGroup("③ 送り先（FactorEye）");
  WifiStarter.addText("server", "サーバーアドレス", "", 80).required().startsWith("http://")
      .placeholder("http://192.168.1.50:8000").help("http:// で始めます（https は未対応）");
  // API キーは、なしでも動く（空なら X-API-Key ヘッダーを付けずに送る。キーなしで受け付けるサーバー向け）
  WifiStarter.addPassword("apikey", "API キー（なしでも可）").clearable()
      .help("キーが必要なサーバー（FactorEye の INGEST_API_KEY）のときだけ入力します。空のまま保存すると、今の値を残します");
  WifiStarter.addSelect("interval", "送る間隔", "10=10 秒|30=30 秒|60=1 分|300=5 分", "30");

  // ID の初期値には、台ごとに違う識別（suffix）を入れる。同じ ID に複数の台が書くと、値が混ざるため
  String suffix = deviceSuffix();
  WifiStarter.addGroup("④ 書き込む ID（FactorEye に登録した ID）");
  const char* sensorShown = "sensor=auto";  // センサーをつなぐときだけ表示
  WifiStarter.addText("id_temp", "温度", String(BOARD.idPrefix) + "-" + suffix + "-temp").mono().identifier().required().showWhen(sensorShown);
  WifiStarter.addText("id_humi", "湿度", String(BOARD.idPrefix) + "-" + suffix + "-humi").mono().identifier().required().showWhen(sensorShown);
  WifiStarter.addText("id_press", "気圧", String(BOARD.idPrefix) + "-" + suffix + "-press")
      .mono().identifier().required().showWhen(sensorShown)
      .help("FactorEye に同じ ID のセンサーを先に登録しておきます（未登録の ID は送れません）。台ごとに変えてください。半角の英数字と . _ - が使えます。単位: ℃・%・hPa");

  WifiStarter.addGroup(String("⑤ 入出力ポート（") + BOARD.name + "）");
  for (size_t i = 0; i < BOARD.portCount; i++) {
    const PortInfo& port = BOARD.ports[i];
    String modeKey = portKey(port.name, "mode");
    String pulseOnly = modeKey + "=pulse";  // パルスを数えるときだけ表示
    WifiStarter.addSelect(modeKey, String(port.name) + " の使い方（" + port.note + "）", portModeOptions(port), "off");
    WifiStarter.addSelect(portKey(port.name, "lvl"), String(port.name) + " センサーが ON のときの電圧",
                          "low=LOW（NPN・接点。内部プルアップを使う）|high=HIGH（PNP）", "low")
        .showWhen(pulseOnly)
        .help(port.inputOnly ? "入力専用のポートは、内部プルアップがないので、LOW のときは、外付けの抵抗が要ります"
                             : "センサーの出力が、ON のとき LOW になる型（NPN・接点）か、HIGH になる型（PNP）か");
    WifiStarter.addNumber(portKey(port.name, "deb"), String(port.name) + " デバウンス（ミリ秒）", PULSE_DEBOUNCE_DEFAULT_MS,
                          0, PULSE_DEBOUNCE_MAX_MS)
        .showWhen(pulseOnly)
        .help("短いチャタリングを、1 つとして数えない時間。物体の最短の間隔より、短くします");
    WifiStarter.addNumber(portKey(port.name, "stop"), String(port.name) + " 停止とみなす秒数", PULSE_STOP_DEFAULT_SECONDS,
                          1, PULSE_STOP_MAX_SECONDS)
        .showWhen(pulseOnly)
        .help("最後の信号から、この秒数なければ「停止」。物体の最長の間隔より、長くします（10 秒以上の間隔のラインは、10 より大きく）");
    WifiStarter.addText(portKey(port.name, "id"), String(port.name) + " の書き込む ID（パルスのときは、個数）",
                        String(BOARD.idPrefix) + "-" + suffix + "-" + String(port.name).substring(0))
        .mono().identifier().required().showWhen(modeKey + "=din|dinpu|ain|pulse");
    WifiStarter.addText(portKey(port.name, "idrun"), String(port.name) + " 稼働 ID（なくてもよい）", "")
        .mono().identifier().showWhen(pulseOnly)
        .help("5 秒ごとに、稼働なら 1、停止なら 0 を送ります。空なら送りません（個数だけ送ります）");
  }
}

// パルスの割り込み。数えるだけ（Serial・String・HTTP は、ここでは使わない）
void IRAM_ATTR pulseIsr(void* counter) {
  static_cast<PulseCounter*>(counter)->onEdge(micros(), millis());
}

// 保存した設定を読み、ポートを使える状態にする
void applySettings() {
  sensorType = WifiStarter.setting("sensor");
  if (sensorType != "none") sensorType = "auto";  // 以前の版の ENV2・ENV3・ENV4 も、自動として扱う
  idTemperature = WifiStarter.setting("id_temp");
  idHumidity = WifiStarter.setting("id_humi");
  idPressure = WifiStarter.setting("id_press");
  sendIntervalMs = intervalMs(WifiStarter.settingInt("interval", 30));

  String server = normalizeServerAddress(WifiStarter.setting("server"));
  serverAddress = server;
  settingsProblem = !isHttpAddress(server);
  if (settingsProblem) Serial.println("[Node] サーバーアドレスは http:// で始めてください（送信できません）");
  factoreye.begin(server, WifiStarter.setting("apikey"));

  portSettingCount = 0;
  for (size_t i = 0; i < BOARD.portCount && portSettingCount < 8; i++) {
    const PortInfo& port = BOARD.ports[i];
    PortSetting& setting = portSettings[portSettingCount];
    setting.info = &port;
    setting.mode = parsePortMode(WifiStarter.setting(portKey(port.name, "mode")));
    setting.ingestId = WifiStarter.setting(portKey(port.name, "id"));
    setting.runId = WifiStarter.setting(portKey(port.name, "idrun"));
    if (setting.mode == PortMode::Off) continue;
    portSettingCount++;
    switch (setting.mode) {
      case PortMode::Pulse: {
        bool onLow = isOnLevelLow(WifiStarter.setting(portKey(port.name, "lvl")));
        long debounceMs = WifiStarter.settingInt(portKey(port.name, "deb"), PULSE_DEBOUNCE_DEFAULT_MS);
        long stopSeconds = WifiStarter.settingInt(portKey(port.name, "stop"), PULSE_STOP_DEFAULT_SECONDS);
        setting.stopMs = (unsigned long)stopSeconds * 1000UL;
        // 入力専用のピン（G34〜G39）には、内部プルアップがない
        pinMode(port.pin, (onLow && !port.inputOnly) ? INPUT_PULLUP : INPUT);
        setting.counter.begin((uint32_t)debounceMs * 1000UL, millis());
        attachInterruptArg(digitalPinToInterrupt(port.pin), pulseIsr, &setting.counter, onLow ? FALLING : RISING);
        break;
      }
      case PortMode::DigitalIn:       pinMode(port.pin, INPUT); break;
      case PortMode::DigitalInPullup: pinMode(port.pin, INPUT_PULLUP); break;
      case PortMode::AnalogIn:        pinMode(port.pin, INPUT); break;
      case PortMode::DigitalOut:      pinMode(port.pin, OUTPUT); digitalWrite(port.pin, LOW); break;  // 出力の使い方は今後追加
      case PortMode::Off:             break;
    }
  }

  // 送り先の一覧（異常の判断に使う）。センサーとポートの、ID が決まっているものだけ
  targetCount = 0;
  auto addTarget = [](const String& id) { if (!id.isEmpty() && targetCount < 12) targets[targetCount++].ingestId = id; };
  if (sensorType != "none") { addTarget(idTemperature); addTarget(idHumidity); addTarget(idPressure); }
  for (size_t i = 0; i < portSettingCount; i++) {
    if (portSettings[i].mode != PortMode::DigitalOut) addTarget(portSettings[i].ingestId);
    if (portSettings[i].mode == PortMode::Pulse) addTarget(portSettings[i].runId);  // 空なら、足されない
  }
  // FactorEye 側が自動登録（INGEST_AUTO_CREATE）のときは、名前と単位でセンサーが作られる。登録済みなら無視される
  auto describe = [](const String& id, const char* label, const char* unit) {
    if (!id.isEmpty()) factoreye.setSensorInfo(id, id + " " + label, unit);
  };
  if (sensorType != "none") {
    describe(idTemperature, "温度", "℃");
    describe(idHumidity, "湿度", "%");
    describe(idPressure, "気圧", "hPa");
  }
  for (size_t i = 0; i < portSettingCount; i++) {
    const PortSetting& port = portSettings[i];
    switch (port.mode) {
      case PortMode::Pulse:
        describe(port.ingestId, "生産数", "個");
        describe(port.runId, "稼働", "");
        break;
      case PortMode::AnalogIn: describe(port.ingestId, "入力", "V"); break;
      case PortMode::DigitalIn:
      case PortMode::DigitalInPullup: describe(port.ingestId, "入力", ""); break;
      default: break;
    }
  }
  if (targetCount == 0) {
    settingsProblem = true;
    Serial.println("[Node] 送るものがありません（センサーもポートも使わない設定です）");
  }
}

// センサーを使える状態にする。見つからないときは false（あとで再試行する）
bool startSensor() {
  if (sensorType == "none") return true;
  return envSensor.begin(sensorType, BOARD.sdaPin, BOARD.sclPin);
}

// ID が決まっている値だけ送る。送れたら true（その ID の最後に送れた時刻を更新する）
bool sendValue(const String& ingestId, float value) {
  if (ingestId.isEmpty()) return false;
  bool sent = factoreye.send(ingestId, value);
  if (sent) {
    for (size_t i = 0; i < targetCount; i++) {
      if (targets[i].ingestId == ingestId) targets[i].lastSuccessMs = millis();
    }
  }
  Serial.printf("[Node] %s = %.2f  %s\n", ingestId.c_str(), value, sent ? "送信OK" : "送信できず（溜めて再送します）");
  return sent;
}

// 1 回分: センサーとポートを読んで送る
void readAndSendAll() {
  if (sensorType != "none" && envSensor.isReady()) {
    float celsius, humidity, hectopascal;
    if (envSensor.readClimate(celsius, humidity)) {
      status.hasClimate = isSaneTemperature(celsius) && isSaneHumidity(humidity);
      status.temperature = celsius;
      status.humidity = humidity;
      if (isSaneTemperature(celsius)) sendValue(idTemperature, celsius);
      if (isSaneHumidity(humidity)) sendValue(idHumidity, humidity);
    }
    if (envSensor.readPressure(hectopascal) && isSanePressure(hectopascal)) {
      status.hasPressure = true;
      status.pressure = hectopascal;
      sendValue(idPressure, hectopascal);
    }
  }
  for (size_t i = 0; i < portSettingCount; i++) {
    const PortSetting& port = portSettings[i];
    if (port.mode == PortMode::DigitalIn || port.mode == PortMode::DigitalInPullup) {
      sendValue(port.ingestId, digitalRead(port.info->pin));
    } else if (port.mode == PortMode::AnalogIn) {
      sendValue(port.ingestId, analogReadMilliVolts(port.info->pin) / 1000.0f);  // V
    }
  }
}

// サーバーに届くかを確かめて、シリアルに出す（原因の切り分け用）。起動後の最初と、まだ 1 つも送れていない間は 2 分ごと
void probeServer() {
  HTTPClient http;
  http.setConnectTimeout(5000);
  http.setTimeout(5000);
  http.begin(serverAddress + "/health");
  int code = http.GET();
  Serial.printf("[Node] サーバー確認 %s/health → %d%s  自分の IP=%s 電波=%d dBm\n", serverAddress.c_str(), code,
                code == 200 ? "（届いています）" : code < 0 ? "（届きません）" : "（届いたが想定外）", WiFi.localIP().toString().c_str(),
                WiFi.RSSI());
  if (code < 0) Serial.printf("[Node]   理由: %s\n", HTTPClient::errorToString(code).c_str());
  http.end();
}

bool anyTargetSucceeded() {
  for (size_t i = 0; i < targetCount; i++) {
    if (targets[i].lastSuccessMs != 0 && targets[i].lastSuccessMs != startMs) return true;
  }
  return false;
}

// パルスのポート: 5 秒ごとに、その間の個数（0 も含む）と、稼働・停止（1/0）を送る
void sendPulseWindows() {
  if (millis() - lastPulseWindowMs < PULSE_WINDOW_MS) return;
  lastPulseWindowMs = millis();
  // WiFi が切れている間は、個数を取り出さない（カウンタに残り、つながったあと、合計で送る）
  if (!WifiStarter.isConnected()) return;
  // サーバーに届かない状態が長く、未送信が溜まっているときも、取り出さない（個数が、溜め場から押し出されないように）
  if (factoreye.pendingCount() >= PULSE_SEND_BUFFER_GUARD) return;
  for (size_t i = 0; i < portSettingCount; i++) {
    PortSetting& port = portSettings[i];
    if (port.mode != PortMode::Pulse) continue;
    sendValue(port.ingestId, (float)port.counter.take());
    if (!port.runId.isEmpty()) {
      bool byTime = runningByTime(port.counter.lastPulseMs(), millis(), port.stopMs);
      sendValue(port.runId, isRunning(byTime, port.external) ? 1.0f : 0.0f);
    }
  }
}

// 黄色の点滅で知らせる異常: 設定に問題がある / センサーが見つからない / どれかの ID が長く送れていない
void updateWarning() {
  bool sensorMissing = sensorType != "none" && !envSensor.isReady();
  bool sendStalled = anyTargetStalled(targets, targetCount, millis(), sendFailureLimitMs(sendIntervalMs));
  WifiStarter.setWarning(settingsProblem || sensorMissing || sendStalled);
  status.warning = settingsProblem || sensorMissing || sendStalled;
  // 画面に出す文字なので、英数字で書く
  status.problem = settingsProblem ? "Check settings (server)"
                   : sensorMissing ? "ENV unit not found"
                   : sendStalled   ? "Cannot send data"
                                   : "";
}

// 画面つきの機種: 1 秒ごとに、状態を画面に出す
void updateScreen() {
  if (millis() - lastScreenMs < 1000) return;
  lastScreenMs = millis();
  status.wifiState = WifiStarter.getState();
  screenShowStatus(status);
}

void setup() {
  if (BOARD.powerHoldPin >= 0) {  // 電池で動かすとき、電源を保つ（StickC Plus2）
    pinMode(BOARD.powerHoldPin, OUTPUT);
    digitalWrite(BOARD.powerHoldPin, HIGH);
  }
  Serial.begin(115200);
  screenBegin();  // 画面つきの機種だけ（それ以外は何もしない）
  WifiStarter.onEvent(screenShowEvent);
  registerSettings();

  WifiStarterConfig config;
  config.buttonPin = BOARD.buttonPin;
  config.ledPin = BOARD.ledPin;
  config.ledPowerPin = BOARD.ledPowerPin;
  config.ledIsMono = BOARD.ledMono;
  config.ledActiveLow = BOARD.ledActiveLow;
  config.buttonWaitMs = BOARD.buttonWaitMs;
  config.apNamePrefix = BOARD.apPrefix;  // 例: M5-NanoC6-Setup-2449（機種が分かる名前にする）
  WifiStarter.begin(config);  // 設定モードのときは、ここで止まる

  applySettings();
  startSensor();
  startMs = millis();
  for (size_t i = 0; i < targetCount; i++) targets[i].lastSuccessMs = startMs;  // 起動から数えて、基準の時間までは待つ
  Serial.printf("[Node] %s / センサー=%s / 間隔=%lu 秒 / ポート %u 個\n", BOARD.name, sensorType.c_str(), sendIntervalMs / 1000,
                (unsigned)portSettingCount);
}

void loop() {
  WifiStarter.loop();

  // センサーが見つからないときは、30 秒ごとにつなぎ直しを試す（あとから挿したときのため）
  if (sensorType != "none" && !envSensor.isReady() && millis() - lastSensorRetryMs > 30000) {
    lastSensorRetryMs = millis();
    startSensor();
  }

  if (WifiStarter.isConnected() && (!probedOnce || (!anyTargetSucceeded() && millis() - lastProbeMs > 120000))) {
    probedOnce = true;
    lastProbeMs = millis();
    probeServer();
  }

  if (WifiStarter.isConnected() && millis() - lastSendMs >= sendIntervalMs) {
    lastSendMs = millis();
    readAndSendAll();
  }
  sendPulseWindows();
  updateWarning();
  updateScreen();
}
