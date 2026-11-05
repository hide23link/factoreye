// WifiStarter の本体。通常モード・再接続・LED・保存領域を扱う。
// 設定モード（アクセスポイントと設定画面）は SetupPortal.cpp。
#include "WifiStarter.h"

#include <Preferences.h>  // ESP32 のフラッシュ（NVS）に設定を保存する
#include <WiFi.h>

#include <algorithm>

#include "SetupPortal.h"

WifiStarterClass WifiStarter;

// WiFi の設定（SSID・パスワード）の保存場所。v0.1 から変えない（書き込み直しても、保存した WiFi を引き継ぐため）
static const char* STORAGE_NAME = "wifistarter";
// アプリ独自の項目の保存場所
static const char* FIELD_STORAGE_NAME = "wsapp";
static const unsigned long BLINK_INTERVAL_MS = 500;

void WifiStarterClass::begin(const WifiStarterConfig& newConfig) {
  config = newConfig;
  if (config.buttonPin >= 0) {
    pinMode(config.buttonPin, INPUT);  // GPIO39 は内部プルアップがない（ATOM Lite は基板側でプルアップ済み）
  }
  if (config.ledIsMono && config.ledPin >= 0) pinMode(config.ledPin, OUTPUT);
  if (config.ledPowerPin >= 0) {
    pinMode(config.ledPowerPin, OUTPUT);
    digitalWrite(config.ledPowerPin, HIGH);  // NanoC6 の RGB LED は、電源ピンを入れてから光る
  }
  // ESP32 は WiFi.begin() のたびに SSID とパスワードを自分の領域にも保存する。
  // 保存はこのライブラリだけで行う（試した間違いのパスワードを残さない・書き込み回数を減らす）
  WiFi.persistent(false);

  Preferences storage;
  storage.begin(STORAGE_NAME, true);
  ssid = storage.getString("ssid", "");
  password = storage.getString("password", "");
  storage.end();

  // 設定モードに入るとき: ボタンを押している / WiFi が未設定 / 必須の項目が未設定（例: 書き込み直した直後）
  // 設定が済んでいるときだけ、ボタンを確かめる（未設定なら、待たずに設定モードに入る）
  bool settingsReady = !ssid.isEmpty() && !hasMissingRequiredField();
  bool wantsSetup = false;
  if (settingsReady) wantsSetup = config.buttonWaitMs > 0 ? waitForButton() : isButtonPressed();
  if (wantsSetup || !settingsReady) {
    runSetupMode();
  }
  startNormalMode();
}

void WifiStarterClass::loop() {
  if (state == WifiState::SetupMode) return;
  bool connected = WiFi.status() == WL_CONNECTED;
  setState(connected ? WifiState::Connected : WifiState::Connecting);
  if (connected) {
    disconnected = false;
  } else {
    watchReconnect();
  }
  updateLed();
}

// ESP32 の保存名は、英数字と _ だけ・15 文字まで。守れないと保存に失敗して、再起動のたびに設定モードに入ってしまう
static bool isValidStorageKey(const String& key) {
  if (key.isEmpty() || key.length() > 15) return false;
  for (char c : key) {
    if (!isalnum((unsigned char)c) && c != '_') return false;
  }
  return true;
}

SettingField& WifiStarterClass::addField(const String& key, const String& label, SettingField::Type type) {
  static SettingField ignoredField;  // 登録できない項目の分。呼び出しをつなげて書けるように、受け皿だけ返す
  ignoredField = SettingField();
  if (!isValidStorageKey(key)) {
    Serial.printf("[WifiStarter] 保存名「%s」は使えません（英数字と _ だけ、15 文字まで）。項目を登録しません\n", key.c_str());
    return ignoredField;
  }
  for (const SettingField& existing : fields) {
    if (existing.key == key) {
      Serial.printf("[WifiStarter] 保存名「%s」は、すでに登録されています。項目を登録しません\n", key.c_str());
      return ignoredField;
    }
  }
  SettingField field;
  field.key = key;
  field.label = label;
  field.type = type;
  field.group = currentGroup;
  fields.push_back(field);
  return fields.back();
}

SettingField& WifiStarterClass::addText(const String& key, const String& label, const String& defaultValue, uint8_t maxLength) {
  SettingField& field = addField(key, label, SettingField::Type::Text);
  field.defaultValue = defaultValue;
  field.maxLength = maxLength;
  return field;
}

SettingField& WifiStarterClass::addNumber(const String& key, const String& label, long defaultValue, long minimum,
                                          long maximum) {
  SettingField& field = addField(key, label, SettingField::Type::Text);
  field.defaultValue = String(defaultValue);
  field.maxLength = 11;  // "-2147483648" まで
  field.numeric(minimum, maximum);
  return field;
}

SettingField& WifiStarterClass::addPassword(const String& key, const String& label, uint8_t maxLength) {
  SettingField& field = addField(key, label, SettingField::Type::Password);
  field.maxLength = maxLength;
  return field;
}

SettingField& WifiStarterClass::addSelect(const String& key, const String& label, const String& optionList,
                                          const String& defaultValue) {
  SettingField& field = addField(key, label, SettingField::Type::Select);
  field.optionList = optionList;
  // 初期値がなければ、先頭の選択肢にする（画面で、どれも選ばれていない状態を作らないため）
  int end = optionList.indexOf('|');
  String first = optionList.substring(0, end < 0 ? optionList.length() : end);
  int equal = first.indexOf('=');
  field.defaultValue = !defaultValue.isEmpty() ? defaultValue : (equal < 0 ? first : first.substring(0, equal));
  return field;
}

String WifiStarterClass::setting(const String& key) {
  String fallback;
  for (const SettingField& field : fields) {
    if (field.key == key) fallback = field.defaultValue;
  }
  Preferences storage;
  storage.begin(FIELD_STORAGE_NAME, true);
  String value = storage.getString(key.c_str(), fallback);
  storage.end();
  return value;
}

long WifiStarterClass::settingInt(const String& key, long fallback) {
  String value = setting(key);
  if (value.isEmpty()) return fallback;
  char* end = nullptr;
  long number = strtol(value.c_str(), &end, 10);
  return (end && *end == '\0') ? number : fallback;
}

String WifiStarterClass::savedSsid() {
  Preferences storage;
  storage.begin(STORAGE_NAME, true);
  String saved = storage.getString("ssid", "");
  storage.end();
  return saved;
}

void WifiStarterClass::clearSettings() {
  Preferences storage;
  storage.begin(STORAGE_NAME, false);
  storage.clear();
  storage.end();
}

const char* WifiStarterClass::lastDisconnectReasonName() {
  if (lastReason == 0) return "";
  return WiFi.disconnectReasonName((wifi_err_reason_t)lastReason);
}

// 画面に出る項目か（showWhen の規則が、今の値で成り立つか）
bool WifiStarterClass::isFieldShown(const SettingField& field) {
  int equal = field.showWhenRule.indexOf('=');
  if (equal < 0) return true;
  String otherKey = field.showWhenRule.substring(0, equal);
  bool otherExists = false;
  for (const SettingField& other : fields) otherExists = otherExists || other.key == otherKey;
  if (!otherExists) return true;  // 相手の項目がなければ、条件なしと同じ（設定画面の確認と同じ扱い）
  String accepted = String("|") + field.showWhenRule.substring(equal + 1) + "|";
  return accepted.indexOf(String("|") + setting(otherKey) + "|") >= 0;
}

bool WifiStarterClass::hasMissingRequiredField() {
  for (const SettingField& field : fields) {
    if (field.isRequired && isFieldShown(field) && setting(field.key).isEmpty()) {
      Serial.printf("[WifiStarter] 必須の項目「%s」が未設定です\n", field.label.c_str());
      return true;
    }
  }
  return false;
}

// 起動直後のチャタリングで誤判定しないよう、50ms の間ずっと押されているかを見る
bool WifiStarterClass::isButtonPressed() {
  if (config.buttonPin < 0) return false;
  for (int i = 0; i < 10; i++) {
    if (digitalRead(config.buttonPin) == HIGH) return false;
    delay(5);
  }
  return true;
}

// 起動してから buttonWaitMs の間、ボタンが押されるのを待つ。待つ間は LED が白く点滅する。押されたら true
bool WifiStarterClass::waitForButton() {
  Serial.printf("[WifiStarter] %lu 秒の間、ボタンを押すと設定モードに入ります\n", config.buttonWaitMs / 1000);
  notify(Event::ButtonWait, String(config.buttonWaitMs / 1000));
  unsigned long start = millis();
  while (millis() - start < config.buttonWaitMs) {
    bool on = (millis() / (config.ledIsMono ? 100 : 250)) % 2 == 0;  // 1 色の LED は、とても速く点滅する
    config.ledIsMono ? setMonoLed(on) : (on ? setLed(255, 255, 255) : setLed(0, 0, 0));
    if (config.buttonPin >= 0 && digitalRead(config.buttonPin) == LOW) {
      delay(30);  // チャタリングを避ける
      if (digitalRead(config.buttonPin) == LOW) return true;
    }
    delay(10);
  }
  config.ledIsMono ? setMonoLed(false) : setLed(0, 0, 0);
  return false;
}

void WifiStarterClass::startNormalMode() {
  Serial.printf("[WifiStarter] 通常モード: %s に接続します\n", ssid.c_str());
  notify(Event::ConnectingWifi, ssid);
  setState(WifiState::Connecting);
  WiFi.onEvent(
      [this](arduino_event_id_t, arduino_event_info_t info) {
        int reason = info.wifi_sta_disconnected.reason;
        if (reason != WIFI_REASON_ASSOC_LEAVE) lastReason = reason;  // ASSOC_LEAVE は自分で切ったときの理由
      },
      ARDUINO_EVENT_WIFI_STA_DISCONNECTED);
  WiFi.mode(WIFI_STA);
  WiFi.setAutoReconnect(true);  // 多くの理由では ESP32 がすぐ再接続する。それで戻らないときは watchReconnect() が補う
  WiFi.begin(ssid.c_str(), password.c_str());
}

// ESP32 の自動再接続は、認証の失敗（ルーターの再起動中などに起きる）では止まってしまう。
// そのため、切れた状態が続いたら自分でもやり直す。間隔は倍々に延ばす（ルーターに負担をかけないため）
void WifiStarterClass::watchReconnect() {
  unsigned long now = millis();
  if (!disconnected) {
    disconnected = true;
    disconnectedAtMs = now;
    lastRetryMs = now;
    retryIntervalMs = config.retryFirstSeconds * 1000;
    return;
  }
  unsigned long restartAfterMs = config.restartAfterMinutes * 60 * 1000;
  if (restartAfterMs > 0 && now - disconnectedAtMs >= restartAfterMs) {
    Serial.printf("[WifiStarter] %lu 分つながらないので再起動します\n", config.restartAfterMinutes);
    ESP.restart();
  }
  if (now - lastRetryMs < retryIntervalMs) return;

  lastRetryMs = now;
  retryIntervalMs = std::min(retryIntervalMs * 2, config.retryMaxSeconds * 1000);
  retryCount++;
  Serial.printf("[WifiStarter] 再接続 %lu 回目（最後に切れた理由 %d）\n", retryCount, (int)lastReason);
  WiFi.disconnect();
  WiFi.begin(ssid.c_str(), password.c_str());
}

void WifiStarterClass::runSetupMode() {
  setState(WifiState::SetupMode);
  SetupPortal portal(config.apNamePrefix, pageTitle, fields, ssid, [this](const String& key) { return setting(key); });
  portal.start();
  notify(Event::SetupMode, portal.accessPointName(), "http://192.168.100.1/");
  while (true) {
    portal.handle();
    updateLed();
    if (portal.hasResult()) break;
    delay(2);
  }

  if (!portal.keptSavedWifi()) {  // 「保存済みの WiFi をそのまま使う」のときは、WiFi の設定に触れない
    Preferences storage;
    storage.begin(STORAGE_NAME, false);
    storage.putString("ssid", portal.resultSsid());
    storage.putString("password", portal.resultPassword());
    storage.end();
  }
  Preferences fieldStorage;
  fieldStorage.begin(FIELD_STORAGE_NAME, false);
  for (const auto& entry : portal.resultFields()) {
    // 空の値は 0 バイトなので、書けたかどうかは、あとで読み直して確かめる
    fieldStorage.putString(entry.first.c_str(), entry.second);
    if (fieldStorage.getString(entry.first.c_str(), "\x01") != entry.second) {
      Serial.printf("[WifiStarter] 「%s」を保存できませんでした\n", entry.first.c_str());
    }
  }
  fieldStorage.end();

  // 設定画面に「接続成功」と IP を表示する時間を取ってから再起動する。
  // その間は青点灯にする（スマホとの通信が切れても、LED で成功が分かるように）
  config.ledIsMono ? setMonoLed(true) : setLed(0, 0, 255);
  unsigned long start = millis();
  while (millis() - start < 5000) {
    portal.handle();
    delay(2);
  }
  Serial.println("[WifiStarter] 設定を保存しました。再起動します");
  notify(Event::SettingsSaved);
  ESP.restart();
}

void WifiStarterClass::setState(WifiState newState) {
  if (stateAnnounced && state == newState) return;
  stateAnnounced = true;
  state = newState;
  if (stateHandler) stateHandler(state);
}

// 1 色の LED の点滅のしかた（状態ごと）。時刻から、光らせるかを決める
static bool monoLedShouldBeOn(WifiState state, bool warning, unsigned long nowMs) {
  switch (state) {
    case WifiState::SetupMode:
      return (nowMs / 150) % 2 == 0;  // 速い点滅（0.3 秒周期）
    case WifiState::Connecting:
      return (nowMs / 1000) % 2 == 0;  // ゆっくりした点滅（2 秒周期）
    case WifiState::Connected: {
      if (!warning) return true;  // 点灯
      unsigned long t = nowMs % 2000;  // 異常: 2 回ずつ短く点滅して休む
      return t < 100 || (t >= 250 && t < 350);
    }
  }
  return false;
}

// 設定モード: 赤点滅 / 接続中: 青点滅 / 接続済み: 青点灯 / 接続済みでアプリの異常: 黄色の点滅
// （1 色の LED は、点滅のしかたで表す。monoLedShouldBeOn を参照）
void WifiStarterClass::updateLed() {
  if (config.ledIsMono) {
    setMonoLed(monoLedShouldBeOn(state, warning, millis()));
    return;
  }
  bool blinkOn = (millis() / BLINK_INTERVAL_MS) % 2 == 0;
  switch (state) {
    case WifiState::SetupMode:
      blinkOn ? setLed(255, 0, 0) : setLed(0, 0, 0);
      break;
    case WifiState::Connecting:
      blinkOn ? setLed(0, 0, 255) : setLed(0, 0, 0);
      break;
    case WifiState::Connected:
      if (!warning) setLed(0, 0, 255);
      else blinkOn ? setLed(255, 160, 0) : setLed(0, 0, 0);
      break;
  }
}

void WifiStarterClass::setMonoLed(bool on) {
  if (config.ledPin < 0) return;
  uint32_t color = on ? 1 : 0;
  if (color == lastLedColor) return;
  lastLedColor = color;
  digitalWrite(config.ledPin, (on != config.ledActiveLow) ? HIGH : LOW);
}

// 同じ色を何度も送らないよう、前回の色を覚えておく
void WifiStarterClass::setLed(uint8_t red, uint8_t green, uint8_t blue) {
  if (config.ledPin < 0) return;
  uint32_t color = (red << 16) | (green << 8) | blue;
  if (color == lastLedColor) return;
  lastLedColor = color;
  uint8_t scale = config.ledBrightness;
  rgbLedWrite(config.ledPin, red * scale / 255, green * scale / 255, blue * scale / 255);
}
