// PulseGenerator — FactorEyeNode のパルス計測（生産数）を試すための、信号発生器。
//
// 別の M5（NanoC6・M5StickC・M5Stack Basic など）に書き込み、出力のピンを、FactorEyeNode を書き込んだ本体（ATOM Lite など）の
// 入力ポートにつなぐ（GND も、つなぐ）。センサーの「物体が通ったら ON」を、決まったパターンでまねる。
//
//   [この M5]               [FactorEyeNode の本体]
//   出力ピン ───────────→ 入力ポート（例: G19。使い方「パルスを数える」）
//   GND ────────────────── GND
//
// 配線の電圧: どちらも 3.3V 系なので、そのままつなげる（5V 系につながない）。
// パターン（繰り返す）:
//   ① 0.3 秒間隔で 40 回   → 1 秒未満の連続。5 秒の窓に、約 16〜17 個ずつ入る
//   ② 12 秒間隔で 5 回      → 間隔が 10 秒以上のライン（停止とみなす秒数が 10 秒以下だと、「停止」と出る）
//   ③ チャタリング付きで 20 回 → 1 回の信号に、数ミリ秒の揺れを付ける。デバウンスが効けば、20 個
//   ④ 70 秒の停止          → 1 分以上の停止。稼働 ID が 0 になる（停止とみなす秒数が 60 秒なら）
// 発生したパルスの数は、シリアルに出す（FactorEye の合計と見比べる）。
//
// ON の電圧: 既定は、ON のとき LOW（NPN・接点と同じ）。FactorEyeNode の設定で「センサーが ON のときの電圧」を LOW にする。
// PNP（ON で HIGH）を試すときは、下の ACTIVE_LOW を false にして、FactorEyeNode の設定も HIGH にする。
#include <Arduino.h>

// 出力のピン（機種ごとの、使える GPIO。Grove の 2 本や、ヘッダーのピン）
#if defined(ARDUINO_M5STACK_NANOC6)
const int OUTPUT_PIN = 2;  // Grove の黄色い線
#elif defined(ARDUINO_M5STACK_STICKC) || defined(ARDUINO_M5STACK_STICKC_PLUS) || defined(ARDUINO_M5STACK_STICKC_PLUS2)
const int OUTPUT_PIN = 26;  // Hat の G26
#elif defined(ARDUINO_M5STACK_CORE)
const int OUTPUT_PIN = 26;  // Port B の G26
#elif defined(ARDUINO_M5STACK_ATOM)
const int OUTPUT_PIN = 22;  // G22
#else
const int OUTPUT_PIN = 2;
#endif

const bool ACTIVE_LOW = true;        // ON のとき LOW にする（NPN・接点と同じ）
const unsigned long PULSE_MS = 50;   // 1 回の ON の長さ（物体が通る間）

unsigned long totalPulses = 0;       // 出したパルスの合計

void setLine(bool on) { digitalWrite(OUTPUT_PIN, (on == ACTIVE_LOW) ? LOW : HIGH); }

// 1 回のパルス（ON を PULSE_MS だけ）
void pulse() {
  setLine(true);
  delay(PULSE_MS);
  setLine(false);
  totalPulses++;
}

// チャタリング付きのパルス: ON の立ち上がりで、数ミリ秒の間に、ON/OFF を数回くり返す
void pulseWithBounce() {
  for (int i = 0; i < 3; i++) {
    setLine(true);
    delayMicroseconds(300);
    setLine(false);
    delayMicroseconds(400);
  }
  setLine(true);
  delay(PULSE_MS);
  setLine(false);
  totalPulses++;
}

void report(const char* name, unsigned long count) {
  Serial.printf("[PulseGenerator] %s: %lu 個（合計 %lu 個）\n", name, count, totalPulses);
}

void setup() {
  Serial.begin(115200);
  pinMode(OUTPUT_PIN, OUTPUT);
  setLine(false);
  Serial.printf("[PulseGenerator] 出力ピン G%d、ON は %s。10 秒後に始めます\n", OUTPUT_PIN, ACTIVE_LOW ? "LOW" : "HIGH");
  delay(10000);
}

void loop() {
  Serial.println("[PulseGenerator] ① 0.3 秒間隔で 40 回");
  for (int i = 0; i < 40; i++) {
    pulse();
    delay(300 - PULSE_MS);
  }
  report("①", 40);

  Serial.println("[PulseGenerator] ② 12 秒間隔で 5 回");
  for (int i = 0; i < 5; i++) {
    pulse();
    delay(12000 - PULSE_MS);
  }
  report("②", 5);

  Serial.println("[PulseGenerator] ③ チャタリング付きで 20 回（1 秒間隔）");
  for (int i = 0; i < 20; i++) {
    pulseWithBounce();
    delay(1000 - PULSE_MS);
  }
  report("③", 20);

  Serial.println("[PulseGenerator] ④ 70 秒の停止");
  delay(70000);
  report("④", 0);
}
