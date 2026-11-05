// 設定画面に足す、アプリ独自の項目 1 つ分。WifiStarter.addText() などで登録する（直接は作らない）。
//
// 例（アプリの setup() で、WifiStarter.begin() より前に登録する）:
//   WifiStarter.setTitle("センサーノード設定");
//   WifiStarter.addGroup("センサー");
//   WifiStarter.addSelect("sensor", "つないでいるユニット", "ENV3|ENV4|ENV2", "ENV3");
//   WifiStarter.addGroup("送り先");
//   WifiStarter.addText("server", "サーバーアドレス").required().startsWith("http://");
//   WifiStarter.addPassword("apikey", "API キー").required();
//   WifiStarter.addNumber("stop", "停止とみなす秒数", "60", 1, 86400);   // 数字の入力欄（範囲つき）
//   WifiStarter.addSelect("g19_mode", "G19 の使い方", "off=使わない|din=デジタル入力");
//   WifiStarter.addText("g19_id", "書き込む ID").showWhen("g19_mode=din");   // 入力にしたときだけ表示
// 読み出し: WifiStarter.setting("server")
#pragma once
#include <Arduino.h>

struct SettingField {
  enum class Type { Text, Password, Select };

  String key;  // 保存名。英数字と _ だけ、15 文字まで（ESP32 の保存領域の決まり。守れない項目は登録しない）
  String label;
  Type type = Type::Text;
  String defaultValue;
  String optionList;  // Select のとき。"値=表示|値=表示"（"=表示" を省くと、値をそのまま表示する）
  String helpText;
  String showWhenRule;  // 例 "g19_mode=din|ain"。別の項目がこのどれかの値のときだけ画面に出す
  String placeholderText;
  String group;  // 画面での見出し（addGroup で決めた値）
  String prefixRule;  // 例 "http://"。この文字で始まっていなければ受け付けない
  bool isMono = false;
  bool isRequired = false;
  bool isIdentifier = false;  // 半角の英数字と . _ - だけ使える（ID・名前向け）
  bool isNumeric = false;     // 整数だけ（minValue〜maxValue の範囲）。画面では数字用のキーボードを出す
  long minValue = 0;
  long maxValue = 0;
  bool isClearable = false;   // パスワード型で、必須でないとき: 保存した値を消せる（空のままの保存は「変えない」なので、消すには画面のチェックが要る）
  uint8_t maxLength = 64;

  // 呼び出しをつなげて書けるようにする（例: addText(...).required().help("...")）
  SettingField& help(const String& text) { helpText = text; return *this; }
  SettingField& showWhen(const String& rule) { showWhenRule = rule; return *this; }
  SettingField& placeholder(const String& text) { placeholderText = text; return *this; }
  SettingField& mono() { isMono = true; return *this; }  // 等幅の文字で表示（ID など）
  SettingField& required() { isRequired = true; return *this; }
  SettingField& startsWith(const String& prefix) { prefixRule = prefix; return *this; }
  SettingField& identifier() { isIdentifier = true; return *this; }
  SettingField& clearable() { isClearable = true; return *this; }
  SettingField& numeric(long minimum, long maximum) {  // 整数だけ受け付ける（範囲つき）
    isNumeric = true;
    minValue = minimum;
    maxValue = maximum;
    return *this;
  }
};
