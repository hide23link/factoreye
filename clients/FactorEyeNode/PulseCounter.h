// パルス（物体が通ったときの ON 信号）を数える。割り込み（ISR）から呼ぶ。
//
// 使い方:
//   PulseCounter counter;
//   counter.begin(debounceUs, millis());                       // 設定を読んだあとに 1 回
//   attachInterruptArg(pin, isr, &counter, FALLING);           // isr の中で counter.onEdge(micros(), millis())
//   uint32_t count = counter.take();                           // loop から。数えた個数を取り出して、0 に戻す
//   uint32_t last = counter.lastPulseMs();                     // 最後に数えた時刻（停止の判定に使う: RunJudge.h）
//
// 取りこぼさない理由: 数えるのは割り込みなので、loop() が HTTP で数秒止まっても、数え続ける。
// 時刻の差は、符号なしの引き算で行う（micros() は約 71 分、millis() は約 49 日で 0 に戻っても、差は正しい）。
// ハードウェアに触らないので、PC 上でテストできる（PC では、IRAM_ATTR と臨界区間は何もしない）。
#pragma once
#include <stdint.h>

#if defined(ESP_PLATFORM)
#include <freertos/FreeRTOS.h>
#include <freertos/portmacro.h>
// ISR（割り込み）と loop（通常の処理）が、同じ変数を、同時に触らないようにする
static portMUX_TYPE pulseCounterMux = portMUX_INITIALIZER_UNLOCKED;
#define PULSE_ENTER_FROM_ISR() portENTER_CRITICAL_ISR(&pulseCounterMux)
#define PULSE_EXIT_FROM_ISR() portEXIT_CRITICAL_ISR(&pulseCounterMux)
#define PULSE_ENTER() portENTER_CRITICAL(&pulseCounterMux)
#define PULSE_EXIT() portEXIT_CRITICAL(&pulseCounterMux)
#else
#ifndef IRAM_ATTR
#define IRAM_ATTR
#endif
#define PULSE_ENTER_FROM_ISR()
#define PULSE_EXIT_FROM_ISR()
#define PULSE_ENTER()
#define PULSE_EXIT()
#endif

class PulseCounter {
 public:
  // debounceUs: 1 つ数えてから、この時間（マイクロ秒）の間に来た信号は、数えない（チャタリングを 1 つにする）。
  // startMs: 起動した時刻。最初のパルスが来るまでは、これを「最後のパルスの時刻」とみなす（RunJudge.h の、起動直後の猶予）
  void begin(uint32_t debounceUs, uint32_t startMs) {
    debounceUs_ = debounceUs;
    count_ = 0;
    total_ = 0;
    hasAccepted_ = false;
    lastAcceptedUs_ = 0;
    lastPulseMs_ = startMs;
  }

  // 割り込みから呼ぶ。Serial・String・HTTP などは、ここでは使わない
  void IRAM_ATTR onEdge(uint32_t nowUs, uint32_t nowMs) {
    PULSE_ENTER_FROM_ISR();
    if (!hasAccepted_ || (uint32_t)(nowUs - lastAcceptedUs_) >= debounceUs_) {
      hasAccepted_ = true;
      lastAcceptedUs_ = nowUs;
      lastPulseMs_ = nowMs;
      count_++;
      total_++;
    }
    PULSE_EXIT_FROM_ISR();
  }

  // 数えた個数を取り出して、0 に戻す（読むのと、戻すのを、1 まとまりで行う）
  uint32_t take() {
    PULSE_ENTER();
    uint32_t taken = count_;
    count_ = 0;
    PULSE_EXIT();
    return taken;
  }

  uint32_t lastPulseMs() const {
    PULSE_ENTER();
    uint32_t last = lastPulseMs_;
    PULSE_EXIT();
    return last;
  }

  uint32_t total() const { return total_; }  // 起動してからの合計（確認用）

 private:
  uint32_t debounceUs_ = 20000;
  volatile uint32_t count_ = 0;
  volatile uint32_t total_ = 0;
  volatile bool hasAccepted_ = false;
  volatile uint32_t lastAcceptedUs_ = 0;
  volatile uint32_t lastPulseMs_ = 0;
};
