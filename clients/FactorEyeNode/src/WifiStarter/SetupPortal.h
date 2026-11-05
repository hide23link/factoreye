// 設定モードの中身: アクセスポイント・DNS（スマホを設定画面へ誘導）・Web サーバー。
// WifiStarter.cpp の runSetupMode() からだけ使う。
//
// 画面（SetupPage.h）が呼ぶ URL:
//   GET  /         設定画面
//   GET  /fields   画面に出す項目と今の値 → {"savedSsid":"abc","fields":[{"key":"sensor","label":"..","type":"select",..}]}
//   GET  /scan     近くの SSID 一覧  → {"scanning":false,"networks":[{"ssid":"abc","rssi":-50,"locked":true}]}
//   POST /rescan   SSID を探し直す
//   POST /connect  ssid=...&password=...&f_<項目名>=...  → WiFi に接続を試す。成功したら WiFi と項目を保存
//   POST /keep     f_<項目名>=...  → 保存済みの WiFi をそのまま使い、項目だけ保存
//   GET  /status   → {"state":"idle|trying|connected|failed","reason":"password|notfound|","ip":"192.168.0.10","ssid":"abc","kept":false}
//   上記以外        すべて / へ転送（スマホの「ログインが必要です」表示を出すため）
#pragma once
#include <Arduino.h>
#include <DNSServer.h>
#include <WebServer.h>
#include <WiFi.h>

#include <functional>
#include <deque>
#include <utility>
#include <vector>

#include "SettingField.h"

class SetupPortal {
 public:
  // currentValue: 項目の今の値（保存した値、なければ初期値）を返す関数
  SetupPortal(const char* apNamePrefix, const String& pageTitle, const std::deque<SettingField>& fields,
              const String& savedSsid, std::function<String(const String&)> currentValue);
  void start();
  void handle();  // loop の中で毎回呼ぶ

  const String& accessPointName() const { return apName; }
  bool hasResult() const { return connectState == ConnectState::Connected; }
  bool keptSavedWifi() const { return keptWifi; }  // true のとき、WiFi は保存し直さない
  const String& resultSsid() const { return trySsid; }
  const String& resultPassword() const { return tryPassword; }
  const std::vector<std::pair<String, String>>& resultFields() const { return pendingFields; }

 private:
  enum class ConnectState { Idle, Trying, Connected, Failed };

  void setupRoutes();
  void handleTop();
  void handleFields();
  void handleScan();
  void handleRescan();
  void handleConnect();
  void handleKeep();
  void handleStatus();
  void redirectToTop();
  void sendError(int code, const String& message);
  bool readFields(String& error);
  bool isShown(const SettingField& field, const std::vector<std::pair<String, String>>& values) const;
  void startScan();
  void collectScanResult();
  void checkConnecting();
  void giveUp();

  const char* apNamePrefix;
  String pageTitle;
  const std::deque<SettingField>& fields;
  String savedSsid;
  std::function<String(const String&)> currentValue;
  String apName;
  WebServer server{80};
  DNSServer dns;
  String networksJson = "[]";
  ConnectState connectState = ConnectState::Idle;
  bool keptWifi = false;
  String trySsid;
  String tryPassword;
  std::vector<std::pair<String, String>> pendingFields;  // 接続に成功したら保存する項目の値
  unsigned long tryStartMs = 0;
  volatile int tryReason = 0;  // 試している間に切れた理由。WiFi のイベント（別のタスク）から書き込まれる
  const char* failReason = "";  // 画面に出し分ける理由: "password" / "notfound" / ""
};
