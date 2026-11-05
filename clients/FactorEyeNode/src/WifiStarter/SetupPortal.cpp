// 設定モードの中身。流れと URL の一覧は SetupPortal.h の冒頭を参照。
#include "SetupPortal.h"

#include <esp_mac.h>   // esp_read_mac()
#include <esp_wifi.h>  // esp_wifi_scan_stop()（WiFi.scanDelete() は検索を止めないため）

#include "SetupPage.h"

// 192.168.0.x / 192.168.1.x は工場や家庭の LAN と重なりやすいので避ける
static const IPAddress AP_ADDRESS(192, 168, 100, 1);
static const IPAddress AP_SUBNET(255, 255, 255, 0);
static const unsigned long CONNECT_TIMEOUT_MS = 15000;
static const int MAX_NETWORKS = 20;
static const unsigned int MAX_PREFIX_BYTES = 20;  // SSID は 32 バイトまで。「-EEFF」の 5 バイトを足しても収まるように

static String escapeJson(const String& text) {
  String result;
  for (char c : text) {
    if (c == '"' || c == '\\') {
      result += '\\';
      result += c;
    } else if ((uint8_t)c < 0x20) {
      result += ' ';
    } else {
      result += c;
    }
  }
  return result;
}

// 半角の英数字と . _ - だけか（ID・名前向けの項目）
static bool isIdentifierText(const String& text) {
  for (char c : text) {
    if (!isalnum((unsigned char)c) && c != '.' && c != '_' && c != '-') return false;
  }
  return true;
}

// 前後の空白を取る。スマホで貼り付けたときに紛れ込む空白で、認証が通らなくなるのを防ぐため
static String trimmed(const String& text) {
  String result = text;
  result.trim();
  return result;
}

// 整数として読めて、min〜max に収まるか（数字だけ。符号は、min が負のときだけ許す）
static bool isIntegerInRange(const String& text, long minimum, long maximum) {
  if (text.isEmpty()) return false;
  size_t start = (text[0] == '-' && minimum < 0) ? 1 : 0;
  if (start == text.length() || text.length() - start > 9) return false;  // 9 桁まで（桁あふれを避ける）
  for (size_t i = start; i < text.length(); i++) {
    if (!isdigit((unsigned char)text[i])) return false;
  }
  long value = strtol(text.c_str(), nullptr, 10);
  return value >= minimum && value <= maximum;
}

// WPA2 のパスワードは、ASCII の表示できる文字（空白〜~）だけ使える
static bool isPrintableAscii(const String& text) {
  for (char c : text) {
    if ((uint8_t)c < 0x20 || (uint8_t)c > 0x7E) return false;
  }
  return true;
}

// 切れた理由のうち、それだけで「失敗」と決めてよいもの。それ以外は 15 秒待つ
static const char* decisiveFailReason(int reason) {
  switch (reason) {
    case WIFI_REASON_AUTH_FAIL:
    case WIFI_REASON_4WAY_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_HANDSHAKE_TIMEOUT:
    case WIFI_REASON_MIC_FAILURE:
      return "password";
    case WIFI_REASON_NO_AP_FOUND:
      return "notfound";
    default:
      return nullptr;
  }
}

SetupPortal::SetupPortal(const char* apNamePrefix, const String& pageTitle, const std::deque<SettingField>& fields,
                         const String& savedSsid, std::function<String(const String&)> currentValue)
    : apNamePrefix(apNamePrefix), pageTitle(pageTitle), fields(fields), savedSsid(savedSsid), currentValue(currentValue) {}

void SetupPortal::start() {
  // AP と STA を同時に使う（AP で画面を出しながら、STA で SSID の検索と接続の確認をする）
  WiFi.mode(WIFI_AP_STA);
  WiFi.onEvent(
      [this](arduino_event_id_t, arduino_event_info_t info) {
        int reason = info.wifi_sta_disconnected.reason;
        if (reason != WIFI_REASON_ASSOC_LEAVE) tryReason = reason;  // ASSOC_LEAVE は自分で切ったときの理由
      },
      ARDUINO_EVENT_WIFI_STA_DISCONNECTED);

  // スマホに見える AP の MAC の下4桁を付ける（例: ...:EE:F0 → "EEF0"）。
  // WiFi.softAPmacAddress() は、AP を起動するまで 00:00:… を返すので、esp_read_mac() で直接読む
  String prefix = apNamePrefix;
  if (prefix.length() > MAX_PREFIX_BYTES) prefix = prefix.substring(0, MAX_PREFIX_BYTES);
  uint8_t mac[6];
  esp_read_mac(mac, ESP_MAC_WIFI_SOFTAP);
  char suffix[5];
  snprintf(suffix, sizeof(suffix), "%02X%02X", mac[4], mac[5]);
  apName = prefix + "-" + suffix;

  WiFi.softAPConfig(AP_ADDRESS, AP_ADDRESS, AP_SUBNET);
  if (!WiFi.softAP(apName.c_str())) {  // パスワードなし（誰でも接続できる）
    Serial.println("[WifiStarter] アクセスポイントを起動できませんでした");
  }
#if ESP_IDF_VERSION >= ESP_IDF_VERSION_VAL(5, 4, 2)
  WiFi.AP.enableDhcpCaptivePortal();  // 新しいスマホに「設定画面はここ」と DHCP で伝える（RFC 8910）
#endif
  dns.start(53, "*", AP_ADDRESS);  // どの名前を引いても本機の IP を返す → 設定画面へ誘導される
  setupRoutes();
  server.begin();
  startScan();
  Serial.printf("[WifiStarter] 設定モード: SSID=%s  http://%s/  保存済みの WiFi: %s\n", apName.c_str(),
                AP_ADDRESS.toString().c_str(), savedSsid.isEmpty() ? "なし" : savedSsid.c_str());
}

void SetupPortal::handle() {
  dns.processNextRequest();
  server.handleClient();
  collectScanResult();
  checkConnecting();
}

void SetupPortal::setupRoutes() {
  server.on("/", HTTP_ANY, [this]() { handleTop(); });  // HEAD などで / → / の転送が続かないように ANY で受ける
  server.on("/fields", HTTP_GET, [this]() { handleFields(); });
  server.on("/scan", HTTP_GET, [this]() { handleScan(); });
  server.on("/rescan", HTTP_POST, [this]() { handleRescan(); });
  server.on("/connect", HTTP_POST, [this]() { handleConnect(); });
  server.on("/keep", HTTP_POST, [this]() { handleKeep(); });
  server.on("/status", HTTP_GET, [this]() { handleStatus(); });
  server.onNotFound([this]() { redirectToTop(); });
}

void SetupPortal::handleTop() {
  String page = FPSTR(SETUP_PAGE_HTML);
  page.replace("%TITLE%", pageTitle);
  page.replace("%AP_NAME%", apName);
  page.replace("%AP_ADDRESS%", AP_ADDRESS.toString());
  server.send(200, "text/html; charset=utf-8", page);
}

// "値=表示|値=表示" を 1 つずつに分ける。"=表示" がなければ、値をそのまま表示に使う
static std::vector<std::pair<String, String>> parseOptions(const String& optionList) {
  std::vector<std::pair<String, String>> options;
  int start = 0;
  while (start <= (int)optionList.length()) {
    int end = optionList.indexOf('|', start);
    if (end < 0) end = optionList.length();
    String item = optionList.substring(start, end);
    int equal = item.indexOf('=');
    if (!item.isEmpty()) {
      options.push_back(equal < 0 ? std::make_pair(item, item)
                                  : std::make_pair(item.substring(0, equal), item.substring(equal + 1)));
    }
    start = end + 1;
  }
  return options;
}

// 画面に出す項目と今の値。パスワードの項目は、値を送らない（誰でも読める画面なので）。入力が空なら、今の値を残す
void SetupPortal::handleFields() {
  String body = String("{\"savedSsid\":\"") + escapeJson(savedSsid) + "\",\"fields\":[";
  for (size_t i = 0; i < fields.size(); i++) {
    const SettingField& f = fields[i];
    if (i > 0) body += ",";
    const char* type = f.type == SettingField::Type::Select ? "select" : f.type == SettingField::Type::Password ? "password" : "text";
    String value = currentValue(f.key);
    body += String("{\"key\":\"") + escapeJson(f.key) + "\",\"label\":\"" + escapeJson(f.label) + "\",\"type\":\"" + type +
            "\",\"group\":\"" + escapeJson(f.group) + "\",\"help\":\"" + escapeJson(f.helpText) + "\",\"showWhen\":\"" +
            escapeJson(f.showWhenRule) + "\",\"placeholder\":\"" + escapeJson(f.placeholderText) + "\",\"mono\":" +
            (f.isMono ? "true" : "false") + ",\"required\":" + (f.isRequired ? "true" : "false") + ",\"identifier\":" +
            (f.isIdentifier ? "true" : "false") + ",\"numeric\":" + (f.isNumeric ? "true" : "false") + ",\"min\":" +
            String(f.minValue) + ",\"max\":" + String(f.maxValue) + ",\"clearable\":" + (f.isClearable ? "true" : "false") + ",\"startsWith\":\"" + escapeJson(f.prefixRule) + "\",\"maxLength\":" +
            String((int)f.maxLength);
    if (f.type == SettingField::Type::Password) {
      body += String(",\"set\":") + (value.isEmpty() ? "false" : "true");
    } else {
      body += String(",\"value\":\"") + escapeJson(value) + "\"";
    }
    if (f.type == SettingField::Type::Select) {
      body += ",\"options\":[";
      bool first = true;
      for (const auto& option : parseOptions(f.optionList)) {
        if (!first) body += ",";
        first = false;
        body += String("[\"") + escapeJson(option.first) + "\",\"" + escapeJson(option.second) + "\"]";
      }
      body += "]";
    }
    body += "}";
  }
  body += "]}";
  server.send(200, "application/json", body);
}

// "g19_mode=din|ain" のような規則が、今の値で成り立つか（成り立つときだけ、その項目を画面に出す）
bool SetupPortal::isShown(const SettingField& field, const std::vector<std::pair<String, String>>& values) const {
  if (field.showWhenRule.isEmpty()) return true;
  int equal = field.showWhenRule.indexOf('=');
  if (equal < 0) return true;
  String otherKey = field.showWhenRule.substring(0, equal);
  String accepted = String("|") + field.showWhenRule.substring(equal + 1) + "|";
  for (const auto& value : values) {
    if (value.first == otherKey) return accepted.indexOf(String("|") + value.second + "|") >= 0;
  }
  return true;
}

// 送られた項目（f_<項目名>）を確かめて、pendingFields に入れる。おかしければ、画面に出す文を error に入れて false
bool SetupPortal::readFields(String& error) {
  std::vector<std::pair<String, String>> values;
  for (const SettingField& f : fields) {
    String current = currentValue(f.key);
    String value = server.hasArg(String("f_") + f.key) ? server.arg(String("f_") + f.key) : current;
    if (f.type != SettingField::Type::Select) value = trimmed(value);
    bool clearing = f.isClearable && server.arg(String("c_") + f.key) == "1";  // 「保存した値を消す」にチェックが入っている
    if (clearing) value = "";
    else if (f.type == SettingField::Type::Password && value.isEmpty()) value = current;  // 空 ＝ 変えない
    values.push_back({f.key, value});
  }
  for (size_t i = 0; i < fields.size(); i++) {
    const SettingField& f = fields[i];
    const String& value = values[i].second;
    bool shown = isShown(f, values);
    // 隠れている項目も、文字と長さは確かめる（画面からは起きないが、保存領域を守るため）
    for (char c : value) {
      if ((uint8_t)c < 0x20 || (uint8_t)c == 0x7F) { error = f.label + " に使えない文字があります"; return false; }
    }
    if (value.length() > f.maxLength) { error = f.label + " が長すぎます（" + String((int)f.maxLength) + " バイトまで）"; return false; }
    if (!shown) continue;  // 出していない項目は、必須などを確かめない
    if (f.isRequired && value.isEmpty()) { error = f.label + " を入力してください"; return false; }
    if (!value.isEmpty() && f.isNumeric && !isIntegerInRange(value, f.minValue, f.maxValue)) {
      error = f.label + " は、" + String(f.minValue) + "〜" + String(f.maxValue) + " の整数で入力してください";
      return false;
    }
    if (!value.isEmpty() && f.isIdentifier && !isIdentifierText(value)) { error = f.label + " は、半角の英数字と . _ - だけ使えます"; return false; }
    if (!value.isEmpty() && !f.prefixRule.isEmpty() && !value.startsWith(f.prefixRule)) { error = f.label + " は " + f.prefixRule + " で始めてください"; return false; }
    if (f.type == SettingField::Type::Select) {
      bool found = false;
      for (const auto& option : parseOptions(f.optionList)) found = found || option.first == value;
      if (!found) { error = f.label + " の選択が正しくありません"; return false; }
    }
  }
  pendingFields = values;
  return true;
}

void SetupPortal::handleScan() {
  bool scanning = WiFi.scanComplete() == WIFI_SCAN_RUNNING;
  String body = String("{\"scanning\":") + (scanning ? "true" : "false") + ",\"networks\":" + networksJson + "}";
  server.send(200, "application/json", body);
}

void SetupPortal::handleRescan() {
  startScan();
  server.send(200, "application/json", "{\"ok\":true}");
}

void SetupPortal::handleConnect() {
  // 別のスマホから同時に押されたときに、試している接続や成功した結果を壊さない
  if (connectState == ConnectState::Trying || connectState == ConnectState::Connected) {
    sendError(409, "接続を試している最中です");
    return;
  }
  String ssid = server.arg("ssid");
  String password = server.arg("password");
  String fieldError;
  // String の length() はバイト数。SSID の上限 32 は文字数ではなくバイト数
  if (ssid.isEmpty() || ssid.length() > 32) {
    sendError(400, "SSID は 32 バイト（日本語はおよそ 10 文字）までです");
    return;
  }
  // 空はパスワードなしのネットワーク
  if (!password.isEmpty() && (password.length() < 8 || password.length() > 63 || !isPrintableAscii(password))) {
    sendError(400, "パスワードは半角の英数字・記号で 8〜63 文字です");
    return;
  }
  if (!readFields(fieldError)) {
    sendError(400, fieldError);
    return;
  }
  keptWifi = false;
  trySsid = ssid;
  tryPassword = password;
  connectState = ConnectState::Trying;
  tryStartMs = millis();
  tryReason = 0;
  failReason = "";
  esp_wifi_scan_stop();  // 検索中だと接続できないため止める
  WiFi.scanDelete();
  WiFi.setAutoReconnect(false);  // 失敗したら、やり直さずにすぐ結果を出すため
  Serial.printf("[WifiStarter] %s に接続を試します\n", trySsid.c_str());
  if (WiFi.begin(trySsid.c_str(), tryPassword.c_str()) == WL_CONNECT_FAILED) giveUp();
  server.send(200, "application/json", "{\"ok\":true}");
}

// 保存済みの WiFi をそのまま使い、項目だけ保存する（WiFi には接続し直さない）
void SetupPortal::handleKeep() {
  if (connectState == ConnectState::Trying || connectState == ConnectState::Connected) {
    sendError(409, "接続を試している最中です");
    return;
  }
  if (savedSsid.isEmpty()) {
    sendError(400, "保存済みの WiFi がありません");
    return;
  }
  String fieldError;
  if (!readFields(fieldError)) {
    sendError(400, fieldError);
    return;
  }
  keptWifi = true;
  trySsid = savedSsid;
  connectState = ConnectState::Connected;
  server.send(200, "application/json", "{\"ok\":true}");
}

void SetupPortal::handleStatus() {
  const char* names[] = {"idle", "trying", "connected", "failed"};
  String body = String("{\"state\":\"") + names[(int)connectState] + "\",\"reason\":\"" + failReason +
                "\",\"ip\":\"" + WiFi.localIP().toString() + "\",\"ssid\":\"" + escapeJson(trySsid) + "\",\"kept\":" + (keptWifi ? "true" : "false") + "}";
  server.send(200, "application/json", body);
}

void SetupPortal::redirectToTop() {
  server.sendHeader("Location", String("http://") + AP_ADDRESS.toString() + "/", true);
  server.send(302, "text/plain", "");
}

void SetupPortal::sendError(int code, const String& message) {
  server.send(code, "application/json", String("{\"ok\":false,\"error\":\"") + escapeJson(message) + "\"}");
}

void SetupPortal::startScan() {
  if (connectState == ConnectState::Trying) return;
  if (WiFi.scanComplete() == WIFI_SCAN_RUNNING) return;
  WiFi.scanNetworks(true);  // true = 待たずに戻る（検索中も画面が応答できるように）
}

// 検索が終わっていたら、同じ SSID は電波の強い方だけ残し、強い順に並べて JSON にする
void SetupPortal::collectScanResult() {
  int count = WiFi.scanComplete();
  if (count < 0) return;  // 検索中、または検索していない

  int order[MAX_NETWORKS];
  int kept = 0;
  for (int i = 0; i < count; i++) {
    if (WiFi.SSID(i).isEmpty()) continue;  // 名前を隠しているネットワーク
    bool duplicate = false;
    for (int k = 0; k < kept; k++) {
      if (WiFi.SSID(order[k]) != WiFi.SSID(i)) continue;
      duplicate = true;
      if (WiFi.RSSI(i) > WiFi.RSSI(order[k])) order[k] = i;
    }
    if (!duplicate && kept < MAX_NETWORKS) order[kept++] = i;
  }
  std::sort(order, order + kept, [](int a, int b) { return WiFi.RSSI(a) > WiFi.RSSI(b); });

  String json = "[";
  for (int k = 0; k < kept; k++) {
    int i = order[k];
    if (k > 0) json += ",";
    json += "{\"ssid\":\"" + escapeJson(WiFi.SSID(i)) + "\",\"rssi\":" + String(WiFi.RSSI(i)) +
            ",\"locked\":" + (WiFi.encryptionType(i) == WIFI_AUTH_OPEN ? "false" : "true") + "}";
  }
  json += "]";
  networksJson = json;
  WiFi.scanDelete();
}

// パスワード違いなどは、切れた理由（イベント）ですぐ分かる。理由がはっきりしないときは 15 秒で諦める
void SetupPortal::checkConnecting() {
  if (connectState != ConnectState::Trying) return;
  if (WiFi.status() == WL_CONNECTED) {
    connectState = ConnectState::Connected;
    Serial.printf("[WifiStarter] 接続成功 IP=%s\n", WiFi.localIP().toString().c_str());
    return;
  }
  const char* reason = decisiveFailReason(tryReason);
  if (reason) {
    failReason = reason;
    giveUp();
    return;
  }
  if (millis() - tryStartMs > CONNECT_TIMEOUT_MS) giveUp();
}

void SetupPortal::giveUp() {
  connectState = ConnectState::Failed;
  WiFi.disconnect();  // STA だけ切る（AP は残るので、画面からやり直せる）
  Serial.printf("[WifiStarter] 接続失敗（理由 %d）\n", (int)tryReason);
}
