// パルスを数える部分と、稼働・停止の判定（どちらも node_calc.h）を、PC 上で確かめる。実行: ./run.sh
// どちらも、ハードウェアに触らない作りなので、時刻を自分で与えて、境界・折り返し・取り出しを確かめられる。
#include <cstdio>

#define ARDUINO_M5STACK_ATOM 1  // node_calc.h の機種の表を通すため（パルスの部分は機種によらない）
#include "node_calc.h"

static int failures = 0;
static int checks = 0;
#define CHECK(condition)                                               \
  do {                                                                 \
    checks++;                                                          \
    if (!(condition)) {                                                \
      failures++;                                                      \
      std::printf("  NG %s:%d  %s\n", __FILE__, __LINE__, #condition); \
    }                                                                  \
  } while (0)

int main() {
  // ---- 数える・取り出す ----
  PULSE counter;
  pulse_begin(&counter, 20000, 1000);  // デバウンス 20 ms、起動は 1000 ms
  CHECK(pulse_take(&counter) == 0);
  pulse_edge(&counter, 100000, 1100);
  pulse_edge(&counter, 200000, 1200);
  pulse_edge(&counter, 300000, 1300);
  CHECK(pulse_take(&counter) == 3);   // 3 つ数えた
  CHECK(pulse_take(&counter) == 0);   // 取り出したら、0 に戻る（二重に数えない）
  CHECK(counter.total == 3);  // 起動してからの合計は、残る
  CHECK(pulse_last_ms(&counter) == 1300);

  // ---- デバウンス（チャタリング）: 前回から debounceUs 未満は、数えない ----
  pulse_begin(&counter, 20000, 0);
  pulse_edge(&counter, 1000000, 1000);
  pulse_edge(&counter, 1003000, 1003);  // 3 ms 後（チャタリング）
  pulse_edge(&counter, 1010000, 1010);  // 10 ms 後
  pulse_edge(&counter, 1019999, 1019);  // 19.999 ms 後 → まだ数えない
  CHECK(pulse_take(&counter) == 1);
  pulse_edge(&counter, 1020000, 1020);  // ちょうど 20 ms 後 → 数える（以上）
  CHECK(pulse_take(&counter) == 1);
  // 数えなかった信号は、デバウンスの起点を延ばさない（前回「数えた」時刻から測る）
  pulse_begin(&counter, 20000, 0);
  pulse_edge(&counter, 2000000, 2000);
  pulse_edge(&counter, 2015000, 2015);  // 数えない
  pulse_edge(&counter, 2025000, 2025);  // 最初から 25 ms → 数える
  CHECK(pulse_take(&counter) == 2);

  // ---- 1 秒未満の連続（0.3 秒間隔）を、取りこぼさない ----
  pulse_begin(&counter, 20000, 0);
  for (uint32_t i = 0; i < 100; i++) pulse_edge(&counter, 5000000 + i * 300000, 5000 + i * 300);
  CHECK(pulse_take(&counter) == 100);

  // ---- デバウンスなし（0）: すべて数える ----
  pulse_begin(&counter, 0, 0);
  pulse_edge(&counter, 10, 0);
  pulse_edge(&counter, 10, 0);  // 同じ時刻でも、数える
  CHECK(pulse_take(&counter) == 2);

  // ---- 最初の信号は、時刻が 0 でも、必ず数える ----
  pulse_begin(&counter, 20000, 0);
  pulse_edge(&counter, 0, 0);
  CHECK(pulse_take(&counter) == 1);

  // ---- micros()（約 71 分）の折り返し: 差は符号なしの引き算なので、正しい ----
  pulse_begin(&counter, 20000, 0);
  pulse_edge(&counter, 0xFFFFFF00u, 100);       // 折り返しの直前
  pulse_edge(&counter, 0x00000100u, 101);       // 折り返しのあと（差は 0x200 = 512 us）→ デバウンス未満で、数えない
  CHECK(pulse_take(&counter) == 1);
  pulse_edge(&counter, 0x00005000u, 120);       // 折り返しのあと、20 ms 以上 → 数える
  CHECK(pulse_take(&counter) == 1);

  // ---- 最後のパルスの時刻 ----
  pulse_begin(&counter, 20000, 7777);
  CHECK(pulse_last_ms(&counter) == 7777);   // 最初のパルスまでは、起動した時刻（起動直後の猶予）
  pulse_edge(&counter, 1000, 8888);
  CHECK(pulse_last_ms(&counter) == 8888);

  // ---- 稼働・停止（時間による判定）----
  CHECK(run_by_time(1000, 1000, 60000));            // 直後
  CHECK(run_by_time(1000, 61000, 60000));           // ちょうど stopMs → 稼働（超えた時点から停止）
  CHECK(!run_by_time(1000, 61001, 60000));          // 1 ms 超えたら停止
  CHECK(run_by_time(0, 9999, 10000));               // 10 秒の設定で、9.999 秒後は稼働
  CHECK(!run_by_time(0, 10001, 10000));
  // millis()（約 49 日）の折り返し
  CHECK(run_by_time(0xFFFFFF00u, 0x00000100u, 1000));      // 差は 512 ms → 稼働
  CHECK(!run_by_time(0xFFFFFF00u, 0x00001000u, 1000));     // 差は約 4.3 秒 → 停止

  // ---- 別の信号（ハイブリッド）: 外部の信号があれば、そちらを優先 ----
  CHECK(is_running(true, RUN_UNKNOWN));        // 不明なら、時間による判定
  CHECK(!is_running(false, RUN_UNKNOWN));
  CHECK(is_running(false, RUN_ON));       // 外部が「稼働」なら、時間では停止でも、稼働
  CHECK(!is_running(true, RUN_OFF));       // 外部が「停止」なら、時間では稼働でも、停止

  // ---- 起動直後の猶予（再起動の直後に、偽の「停止」を出さない）----
  PULSE fresh;
  pulse_begin(&fresh, 20000, 500000);
  CHECK(run_by_time(pulse_last_ms(&fresh), 500000 + 59000, 60000));    // パルスがなくても、60 秒までは稼働
  CHECK(!run_by_time(pulse_last_ms(&fresh), 500000 + 61000, 60000));   // 61 秒たったら停止

  std::printf("%d 件の確認のうち、失敗 %d 件\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
