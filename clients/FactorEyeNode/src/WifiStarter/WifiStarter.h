// WifiStarter — M5Stack ATOM Lite 用の WiFi 初期設定ライブラリ
//
// アプリの .ino からの使い方:
//   #include <WifiStarter.h>
//   void setup() { WifiStarter.begin(); }   // 設定モードのときは、ここで止まり、設定後に再起動する
//   // 設定画面にアプリ独自の項目を足すときは、begin() の前に addText() などで登録する（SettingField.h）
//   void loop() {
//     WifiStarter.loop();                   // LED の更新・接続状態の確認・切れたときの再接続
//     if (WifiStarter.isConnected()) { ...アプリの処理（WiFi・HTTPClient などを普通に使う）... }
//   }
//
// 処理の流れ:
//   起動時にボタンが押されている、または保存した設定がない
//     → 設定モード: 赤点滅、アクセスポイント（M5-Setup-XXXX）と設定画面を起動
//        → 画面で SSID とパスワードを入力 → 接続できたら保存して再起動
//   それ以外
//     → 通常モード: 保存した設定で接続（接続中は青点滅、接続したら青点灯）
//        → 切れたら、間隔を延ばしながら接続をやり直す。長くつながらなければ再起動する
//   ただし、画面に出る必須の項目が未設定なら、WiFi が保存済みでも設定モードに入る（書き込み直した直後など）
// 仕様の詳細は ../SPEC.md。
#pragma once
#include <Arduino.h>

#include <deque>

#include "SettingField.h"

// 他の M5 機種で使うときは、ここの値を変えて begin() に渡す
struct WifiStarterConfig {
  int buttonPin = 39;               // ATOM Lite の本体ボタン（押すと LOW）。ボタンがない機種は -1
  int ledPin = 27;                  // ATOM Lite の RGB LED（SK6812）。LED がない機種は -1
  // 色を変えられない 1 色の LED（M5StickC の赤い LED など）のとき true。状態は、点滅のしかたで表す:
  //   設定モード = 速い点滅 / 接続中 = ゆっくりした点滅 / 接続済み = 点灯 / アプリの異常 = 2 回ずつ短く点滅 / ボタン待ち = とても速い点滅
  bool ledIsMono = false;
  bool ledActiveLow = false;        // 1 色の LED で、LOW にすると光る（M5StickC はこちら）
  int ledPowerPin = -1;             // LED の電源ピン（NanoC6 は G19。HIGH にしないと光らない）。ない機種は -1
  uint8_t ledBrightness = 40;       // 0〜255。SK6812 は明るいので低めにする
  // 起動直後に、ボタンが押されるのを待つ時間（ミリ秒）。0 なら待たず、起動の瞬間に押されているかを見る（ATOM Lite）。
  // ボタンが起動のモード選びのピンと兼用の機種（NanoC6 の G9）では、押したまま電源を入れるとダウンロードモードに入ってしまうので、
  // 起動してから 4 秒ほど待つ（その間、LED が白く点滅する）
  unsigned long buttonWaitMs = 0;
  const char* apNamePrefix = "M5-Setup";  // SSID は「M5-Setup-」+ MAC の下4桁。20 バイトを超える分は切る

  // 通常モードで切れたときの再接続（30秒 → 1分 → 2分 → 4分 → 5分 → 5分 …）
  unsigned long retryFirstSeconds = 30;   // 切れてから、最初にやり直すまで
  unsigned long retryMaxSeconds = 300;    // やり直す間隔の上限
  unsigned long restartAfterMinutes = 30; // この時間つながらなければ再起動する。0 なら再起動しない
};

enum class WifiState {
  SetupMode,   // 設定モード（アクセスポイントとして動作中）
  Connecting,  // 保存した設定で接続中（または切断されて再接続中）
  Connected,   // 接続済み
};

class WifiStarterClass {
 public:
  void begin(const WifiStarterConfig& config = WifiStarterConfig());
  void loop();

  // ---- 設定画面にアプリ独自の項目を足す（begin() より前に呼ぶ）----
  void setTitle(const String& title) { pageTitle = title; }
  void addGroup(const String& title) { currentGroup = title; }  // これ以降の項目の見出し
  SettingField& addText(const String& key, const String& label, const String& defaultValue = "", uint8_t maxLength = 64);
  SettingField& addPassword(const String& key, const String& label, uint8_t maxLength = 64);
  // 整数の入力欄（minimum〜maximum の範囲。範囲の外・数字以外は、画面でも本機でも断る）。読み出しは settingInt()
  SettingField& addNumber(const String& key, const String& label, long defaultValue, long minimum, long maximum);
  SettingField& addSelect(const String& key, const String& label, const String& optionList, const String& defaultValue = "");
  String setting(const String& key);                  // 保存した値（なければ登録時の初期値）。保存した直後でも再起動までは前の値のこともあるので、begin() のあとで 1 回読む
  long settingInt(const String& key, long fallback);  // 数値として読む。読めなければ fallback

  // アプリの異常（センサーが見つからない・送信が続けて失敗など）を、接続中の青の代わりに黄色の点滅で知らせる
  void setWarning(bool on) { warning = on; }

  bool isConnected() const { return state == WifiState::Connected; }
  WifiState getState() const { return state; }
  String savedSsid();
  void clearSettings();  // 保存した設定を消す（次の起動で設定モードになる）

  // 現場で調べるとき用: 自分でやり直した回数と、最後に切れた理由（ESP32 の番号と名前。例: 201 "NO_AP_FOUND"）
  unsigned long reconnectCount() const { return retryCount; }
  int lastDisconnectReason() const { return lastReason; }
  const char* lastDisconnectReasonName();

  // 画面付きの機種で状態を表示したいときに使う（LED の表示とは別に呼ばれる）
  void onStateChange(void (*handler)(WifiState)) { stateHandler = handler; }

  // 人に見せる場面（出来事）を受け取る。画面付きの機種で、設定モードの手順や、ボタン待ちの案内を出すために使う。
  // 文章ではなく、出来事と値を渡す（画面の側で、使える文字・言葉で組み立てられる。日本語フォントを入れなくてもよい）
  //   ButtonWait    ボタン待ちを始める      first = 待つ秒数
  //   SetupMode     設定モードに入った      first = つなぐ WiFi 名（アクセスポイント）、second = 設定画面のアドレス
  //   ConnectingWifi  通常モードで接続を始める  first = 接続先の SSID
  //   SettingsSaved   保存して、再起動する
  enum class Event { ButtonWait, SetupMode, ConnectingWifi, SettingsSaved };
  void onEvent(void (*handler)(Event, const String& first, const String& second)) { eventHandler = handler; }

 private:
  bool isButtonPressed();
  bool waitForButton();
  bool hasMissingRequiredField();
  bool isFieldShown(const SettingField& field);
  void startNormalMode();
  void watchReconnect();
  void runSetupMode();  // 戻らない（設定が終わると再起動する）
  void setState(WifiState newState);
  void updateLed();
  void setLed(uint8_t red, uint8_t green, uint8_t blue);
  void setMonoLed(bool on);

  SettingField& addField(const String& key, const String& label, SettingField::Type type);

  WifiStarterConfig config;
  std::deque<SettingField> fields;  // deque なので、addXxx() が返す参照は、あとで項目を足しても無効にならない
  String pageTitle = "WiFi 設定";
  String currentGroup;
  bool warning = false;
  WifiState state = WifiState::Connecting;
  bool stateAnnounced = false;  // 最初の状態も stateHandler に知らせるため
  void (*stateHandler)(WifiState) = nullptr;
  void (*eventHandler)(Event, const String&, const String&) = nullptr;
  void notify(Event event, const String& first = "", const String& second = "") {
    if (eventHandler) eventHandler(event, first, second);
  }

  String ssid;
  String password;
  bool disconnected = false;        // 切れている間 true
  unsigned long disconnectedAtMs = 0;
  unsigned long lastRetryMs = 0;
  unsigned long retryIntervalMs = 0;
  unsigned long retryCount = 0;
  volatile int lastReason = 0;      // WiFi のイベント（別のタスク）から書き込まれる

  uint32_t lastLedColor = 0xFFFFFFFF;
};

extern WifiStarterClass WifiStarter;
