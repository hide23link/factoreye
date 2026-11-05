// 稼働（動いている）／停止の判定。いまは「時間」だけで決める。別の信号でも決められる作りにしてある。
//
// 時間による判定: 最後のパルスから stopMs（設定画面の「停止とみなす秒数」）以内なら稼働、超えたら停止。
//   ちょうど stopMs のときは、稼働（超えた時点から停止）。起動直後は、起動を最後のパルスとみなす
//   （PulseCounter.begin の startMs）ので、再起動の直後に、偽の「停止」を出さない。
//
// 別の信号（将来）: ExternalRun に「稼働」か「停止」を入れると、時間による判定より、そちらを優先する。
//   例: 人が入力する稼働・停止（スマホの画面、別の ATOM のボタン）、別の入力ポートの信号。
//   「不明」のときは、時間による判定を使う。いまは、外部の信号を入れる場所がなく、常に「不明」にしている。
//
// ハードウェアに触らないので、PC 上でテストできる。
#pragma once
#include <stdint.h>

// 外部から与えられる稼働・停止の信号
enum class ExternalRun { Unknown, Running, Stopped };

// 時間による判定（符号なしの引き算なので、millis() が 0 に戻っても正しい）
inline bool runningByTime(uint32_t lastPulseMs, uint32_t nowMs, uint32_t stopMs) {
  return (uint32_t)(nowMs - lastPulseMs) <= stopMs;
}

// 稼働か。外部の信号があれば、それを優先し、なければ、時間による判定を使う
inline bool isRunning(bool byTime, ExternalRun external) {
  if (external == ExternalRun::Running) return true;
  if (external == ExternalRun::Stopped) return false;
  return byTime;
}
