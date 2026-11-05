// PC でテストするための Arduino の偽物。WifiStarter が使う分だけ用意している。
// 時刻（millis）はテストが進める。delay() を呼ぶと時刻が進み、テストの「台本」（onDelay）が呼ばれる。
#pragma once
#include <algorithm>
#include <cstdint>
#include <cstdio>
#include <cctype>
#include <cstdlib>
#include <utility>
#include <vector>
#include <functional>
#include <map>
#include <string>

class String {
 public:
  String() {}
  String(const char* text) : value(text ? text : "") {}
  String(const std::string& text) : value(text) {}
  explicit String(int number) : value(std::to_string(number)) {}
  explicit String(long number) : value(std::to_string(number)) {}
  explicit String(unsigned long number) : value(std::to_string(number)) {}
  explicit String(unsigned int number) : value(std::to_string(number)) {}
  const char* c_str() const { return value.c_str(); }
  size_t length() const { return value.size(); }
  bool isEmpty() const { return value.empty(); }
  String substring(size_t from) const { return from >= value.size() ? String() : String(value.substr(from)); }
  String substring(size_t from, size_t to) const { return from >= value.size() ? String() : String(value.substr(from, to - from)); }
  int indexOf(char c, size_t from = 0) const {
    size_t at = value.find(c, from);
    return at == std::string::npos ? -1 : (int)at;
  }
  int indexOf(const String& text, size_t from = 0) const {
    size_t at = value.find(text.value, from);
    return at == std::string::npos ? -1 : (int)at;
  }
  char operator[](size_t i) const { return value[i]; }
  void remove(size_t index) { value.erase(index); }
  bool startsWith(const String& prefix) const { return value.compare(0, prefix.value.size(), prefix.value) == 0; }
  void trim() {
    size_t from = value.find_first_not_of(" \t\r\n");
    size_t to = value.find_last_not_of(" \t\r\n");
    value = from == std::string::npos ? "" : value.substr(from, to - from + 1);
  }
  void toLowerCase() { for (char& c : value) c = (char)tolower((unsigned char)c); }
  void replace(const String& from, const String& to) {
    size_t at = 0;
    while ((at = value.find(from.value, at)) != std::string::npos) {
      value.replace(at, from.value.size(), to.value);
      at += to.value.size();
    }
  }
  String& operator+=(const String& other) { value += other.value; return *this; }
  String& operator+=(const char* other) { value += other; return *this; }
  String& operator+=(char c) { value += c; return *this; }
  bool operator==(const String& other) const { return value == other.value; }
  bool operator!=(const String& other) const { return value != other.value; }
  std::string::const_iterator begin() const { return value.begin(); }
  std::string::const_iterator end() const { return value.end(); }
  friend String operator+(const String& a, const String& b) { return String(a.value + b.value); }
  friend String operator+(const String& a, const char* b) { return String(a.value + b); }
  friend String operator+(const char* a, const String& b) { return String(std::string(a) + b.value); }
  std::string value;
};

#define PROGMEM
#define FPSTR(text) (text)
#define INPUT 1
#define OUTPUT 2
#define LOW 0
#define HIGH 1

namespace fake {
extern unsigned long nowMs;
extern std::function<int(unsigned long)> buttonLevel;  // 時刻 → ボタンの電圧（LOW = 押している）
extern std::function<void()> onDelay;                  // delay() のたびに呼ばれるテストの台本
extern int ledPin, ledRed, ledGreen, ledBlue, ledWrites;
extern std::map<int, int> pinModes;   // pinMode() で決めたピンの向き
extern std::map<int, int> pinLevels;  // digitalWrite() で出したピンの電圧
}

inline unsigned long millis() { return fake::nowMs; }
inline void delay(unsigned long ms) {
  fake::nowMs += ms;
  if (fake::onDelay) fake::onDelay();
}
inline void pinMode(int pin, int mode) { fake::pinModes[pin] = mode; }
inline void digitalWrite(int pin, int level) { fake::pinLevels[pin] = level; }
inline int digitalRead(int) { return fake::buttonLevel ? fake::buttonLevel(fake::nowMs) : HIGH; }
inline void rgbLedWrite(uint8_t pin, uint8_t red, uint8_t green, uint8_t blue) {
  fake::ledPin = pin;
  fake::ledRed = red;
  fake::ledGreen = green;
  fake::ledBlue = blue;
  fake::ledWrites++;
}

struct FakeSerial {
  template <typename... Args>
  void printf(const char*, Args...) {}
  void println(const char*) {}
  void begin(int) {}
};
extern FakeSerial Serial;

// ESP.restart() は本物では戻らない。テストでは例外にして、呼ばれたことを確かめる
struct RestartCalled {};
struct FakeEsp {
  [[noreturn]] void restart() { throw RestartCalled(); }
};
extern FakeEsp ESP;
