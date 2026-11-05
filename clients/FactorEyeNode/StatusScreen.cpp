// 画面つきの機種（M5Stack Basic）の、最低限の状態表示。使い方は StatusScreen.h。
// 文字は英数字だけ（日本語フォントは入れない。容量が小さく、大きな文字で読みやすい）。
#include "StatusScreen.h"

#include "Boards.h"

#if defined(FACTOREYE_NODE_DISPLAY)

#include <M5Unified.h>

static const int WIDTH = 320;
static const uint16_t COLOR_BLACK = 0x0000;
static const uint16_t COLOR_WHITE = 0xFFFF;
static const uint16_t COLOR_RED = 0xC800;
static const uint16_t COLOR_BLUE = 0x041F;
static const uint16_t COLOR_GREEN = 0x0400;
static const uint16_t COLOR_ORANGE = 0xFD20;

static String lastDrawn;  // 前回描いた内容。同じなら描き直さない（ちらつきを避ける）

void screenBegin() {
  auto config = M5.config();
  M5.begin(config);  // 画面の電源とバックライトも、ここで入る
  M5.Display.setBrightness(120);
  M5.Display.fillScreen(COLOR_BLACK);
}

// 1 行を、背景を塗ってから描く
static void line(int y, int height, const String& text, const lgfx::IFont* font, uint16_t color, uint16_t background = COLOR_BLACK,
                 bool right = false) {
  M5.Display.fillRect(0, y, WIDTH, height, background);
  M5.Display.setFont(font);
  M5.Display.setTextColor(color, background);
  M5.Display.setTextDatum(right ? textdatum_t::middle_right : textdatum_t::middle_left);
  M5.Display.drawString(text, right ? WIDTH - 8 : 10, y + height / 2);
}

// 設定モードなど、WifiStarter の出来事。設定モードでは、つなぐ WiFi 名と、設定画面のアドレスを出す
void screenShowEvent(WifiStarterClass::Event event, const String& first, const String& second) {
  lastDrawn = "";
  M5.Display.fillScreen(COLOR_BLACK);
  const lgfx::IFont* big = &fonts::FreeSansBold18pt7b;
  const lgfx::IFont* normal = &fonts::FreeSans12pt7b;
  switch (event) {
    case WifiStarterClass::Event::ButtonWait:
      line(0, 36, "STARTING", big, COLOR_WHITE, COLOR_BLUE);
      line(90, 36, "Press A", big, COLOR_WHITE);
      line(130, 28, "for setup mode", normal, COLOR_WHITE);
      break;
    case WifiStarterClass::Event::SetupMode:
      line(0, 36, "SETUP MODE", big, COLOR_WHITE, COLOR_RED);
      line(56, 28, "Phone WiFi:", normal, COLOR_WHITE);
      line(86, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE);
      line(140, 28, "Open:", normal, COLOR_WHITE);
      line(170, 32, second, &fonts::FreeSansBold9pt7b, COLOR_WHITE);
      break;
    case WifiStarterClass::Event::ConnectingWifi:
      line(0, 36, "WIFI...", big, COLOR_WHITE, COLOR_BLUE);
      line(90, 32, first, &fonts::FreeSansBold12pt7b, COLOR_WHITE);
      break;
    case WifiStarterClass::Event::SettingsSaved:
      line(0, 36, "SAVED", big, COLOR_WHITE, COLOR_GREEN);
      line(90, 36, "Restarting...", big, COLOR_WHITE);
      break;
  }
}

static void valueRow(int y, const char* label, bool has, float value, const char* format) {
  char buffer[32];
  if (has) snprintf(buffer, sizeof(buffer), format, value);
  else snprintf(buffer, sizeof(buffer), "---");
  M5.Display.fillRect(0, y, WIDTH, 44, COLOR_BLACK);
  M5.Display.setFont(&fonts::FreeSans12pt7b);
  M5.Display.setTextColor(COLOR_WHITE, COLOR_BLACK);
  M5.Display.setTextDatum(textdatum_t::middle_left);
  M5.Display.drawString(label, 10, y + 22);
  M5.Display.setFont(&fonts::FreeSansBold18pt7b);
  M5.Display.setTextDatum(textdatum_t::middle_right);  // 右寄せ（桁が増えても、はみ出さない）
  M5.Display.drawString(buffer, WIDTH - 8, y + 22);
}

// 動作中の表示: 状態の帯・温度・湿度・気圧
void screenShowStatus(const NodeStatus& s) {
  bool connected = s.wifiState == WifiState::Connected;
  const char* title = s.warning ? "WARNING" : connected ? "RUNNING" : "WIFI...";
  uint16_t color = s.warning ? COLOR_ORANGE : connected ? COLOR_GREEN : COLOR_BLUE;

  char text[96];
  snprintf(text, sizeof(text), "%s|%.1f|%.1f|%.1f|%s", title, s.hasClimate ? s.temperature : -999.0f,
           s.hasClimate ? s.humidity : -999.0f, s.hasPressure ? s.pressure : -999.0f, s.problem.c_str());
  String signature = text;
  if (signature == lastDrawn) return;
  // 別の画面（ボタン待ち・設定モードなど）から切り替わった最初は、全体を塗りつぶす（行のすきまに、前の画面の文字が残らないように）
  if (lastDrawn.isEmpty()) M5.Display.fillScreen(COLOR_BLACK);
  lastDrawn = signature;

  line(0, 36, title, &fonts::FreeSansBold18pt7b, COLOR_WHITE, color);
  valueRow(60, "TEMP", s.hasClimate, s.temperature, "%.1f C");
  valueRow(110, "HUMI", s.hasClimate, s.humidity, "%.1f %%");
  valueRow(160, "PRES", s.hasPressure, s.pressure, "%.1f hPa");
  if (s.warning && !s.problem.isEmpty()) line(212, 26, s.problem, &fonts::FreeSansBold9pt7b, COLOR_ORANGE);
}

#endif  // FACTOREYE_NODE_DISPLAY
