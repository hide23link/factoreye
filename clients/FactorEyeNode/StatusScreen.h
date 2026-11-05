// 画面つきの機種（M5Stack Basic など）の、状態の表示。LED のない機種では、これが唯一の表示になる。
//
// 使い方（FactorEyeNode.ino から）:
//   screenBegin();                                  // setup() の最初。画面の電源とバックライトを入れる
//   WifiStarter.onEvent(screenShowEvent);           // 設定モードの手順・ボタン待ちの案内を、画面いっぱいに出す
//   screenShowStatus(status);                       // loop() で、1 秒ごとに呼ぶ。状態と、温度・湿度・気圧を出す
// 画面のない機種（Boards.h の hasDisplay が false）では、何もしない（コードも入らない）。
#pragma once
#include <Arduino.h>
#include "src/WifiStarter/WifiStarter.h"

#include "Boards.h"  // 画面つきの機種のとき FACTOREYE_NODE_DISPLAY が決まる

// 画面に出す文字は、英数字だけ（日本語フォントは大きいので入れない）。
// 画面に出す内容（FactorEyeNode.ino が集めて渡す）
struct NodeStatus {
  WifiState wifiState = WifiState::Connecting;
  bool warning = false;           // 異常（橙の表示）
  String problem;                 // 異常の理由（画面に出すので、英数字で書く）
  bool hasClimate = false;        // 温度・湿度を読めたか
  float temperature = 0;
  float humidity = 0;
  bool hasPressure = false;
  float pressure = 0;
};

#if defined(FACTOREYE_NODE_DISPLAY)
void screenBegin();
void screenShowEvent(WifiStarterClass::Event event, const String& first, const String& second);
void screenShowStatus(const NodeStatus& status);
#else
inline void screenBegin() {}
inline void screenShowEvent(WifiStarterClass::Event, const String&, const String&) {}
inline void screenShowStatus(const NodeStatus&) {}
#endif
