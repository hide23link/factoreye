// FactorEyeClient サンプル: M5Stack Atom (ESP32) からFactorEyeへセンサー値を送る最小例。
//
// 配線不要で動くように、ESP32内蔵の温度センサー値をそのまま送信する
// （チップ内部温度なので外気温とは一致しないが、ライブラリの動作確認用としては十分）。
// 実センサー（ENVユニット等）を使う場合は readDemoSensorValue() を置き換えるだけでよい。
//
// 事前準備:
//   1. backend/.env の INGEST_API_KEY を控える
//   2. FactorEyeの設定画面（または /api/sensors）で、下記 kIngestKey と同じ
//      ingestKey を持つセンサーを先に登録しておく（未登録のingestKeyは404になる）
//   3. 下記のWiFi/FactorEyeの接続情報を環境に合わせて書き換える

#include <FactorEyeClient.h>
#include <WiFi.h>

const char* kWifiSsid = "your-wifi-ssid";
const char* kWifiPassword = "your-wifi-password";

// 例: "http://192.168.1.50:8000"（自宅LAN内のFactorEyeバックエンドのアドレス）
const char* kFactorEyeHost = "http://192.168.1.50:8000";
const char* kIngestApiKey = "change-this-in-production";
const char* kIngestKey = "atom-chip-temp-1";

const unsigned long kSendIntervalMs = 10000;

FactorEyeClient factoreye;
unsigned long lastSendAt = 0;

float readDemoSensorValue() {
  // ESP32内蔵温度センサー（配線不要のデモ用）。実センサーに置き換える場合はここを変更する。
  return temperatureRead();
}

void setup() {
  Serial.begin(115200);

  WiFi.begin(kWifiSsid, kWifiPassword);
  Serial.print("WiFi接続中");
  while (WiFi.status() != WL_CONNECTED) {
    delay(500);
    Serial.print(".");
  }
  Serial.println(" 接続完了: " + WiFi.localIP().toString());

  factoreye.begin(kFactorEyeHost, kIngestApiKey);
}

void loop() {
  if (millis() - lastSendAt >= kSendIntervalMs) {
    lastSendAt = millis();

    float value = readDemoSensorValue();
    bool ok = factoreye.send(kIngestKey, value);

    Serial.print("value=");
    Serial.print(value);
    Serial.print(ok ? "  送信成功" : "  送信失敗/バッファ待機中");
    Serial.print("  (未送信バッファ: ");
    Serial.print(factoreye.pendingCount());
    Serial.println("件)");
  }
}
