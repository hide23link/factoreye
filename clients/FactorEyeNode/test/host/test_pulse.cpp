// パルスを数える部分（PulseCounter.h）と、稼働・停止の判定（RunJudge.h）を、PC 上で確かめる。実行: ./run.sh
// どちらも、ハードウェアに触らない作りなので、時刻を自分で与えて、境界・折り返し・取り出しを確かめられる。
#include <cstdio>

#include "PulseCounter.h"
#include "RunJudge.h"

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
  PulseCounter counter;
  counter.begin(20000, 1000);  // デバウンス 20 ms、起動は 1000 ms
  CHECK(counter.take() == 0);
  counter.onEdge(100000, 1100);
  counter.onEdge(200000, 1200);
  counter.onEdge(300000, 1300);
  CHECK(counter.take() == 3);   // 3 つ数えた
  CHECK(counter.take() == 0);   // 取り出したら、0 に戻る（二重に数えない）
  CHECK(counter.total() == 3);  // 起動してからの合計は、残る
  CHECK(counter.lastPulseMs() == 1300);

  // ---- デバウンス（チャタリング）: 前回から debounceUs 未満は、数えない ----
  counter.begin(20000, 0);
  counter.onEdge(1000000, 1000);
  counter.onEdge(1003000, 1003);  // 3 ms 後（チャタリング）
  counter.onEdge(1010000, 1010);  // 10 ms 後
  counter.onEdge(1019999, 1019);  // 19.999 ms 後 → まだ数えない
  CHECK(counter.take() == 1);
  counter.onEdge(1020000, 1020);  // ちょうど 20 ms 後 → 数える（以上）
  CHECK(counter.take() == 1);
  // 数えなかった信号は、デバウンスの起点を延ばさない（前回「数えた」時刻から測る）
  counter.begin(20000, 0);
  counter.onEdge(2000000, 2000);
  counter.onEdge(2015000, 2015);  // 数えない
  counter.onEdge(2025000, 2025);  // 最初から 25 ms → 数える
  CHECK(counter.take() == 2);

  // ---- 1 秒未満の連続（0.3 秒間隔）を、取りこぼさない ----
  counter.begin(20000, 0);
  for (uint32_t i = 0; i < 100; i++) counter.onEdge(5000000 + i * 300000, 5000 + i * 300);
  CHECK(counter.take() == 100);

  // ---- デバウンスなし（0）: すべて数える ----
  counter.begin(0, 0);
  counter.onEdge(10, 0);
  counter.onEdge(10, 0);  // 同じ時刻でも、数える
  CHECK(counter.take() == 2);

  // ---- 最初の信号は、時刻が 0 でも、必ず数える ----
  counter.begin(20000, 0);
  counter.onEdge(0, 0);
  CHECK(counter.take() == 1);

  // ---- micros()（約 71 分）の折り返し: 差は符号なしの引き算なので、正しい ----
  counter.begin(20000, 0);
  counter.onEdge(0xFFFFFF00u, 100);       // 折り返しの直前
  counter.onEdge(0x00000100u, 101);       // 折り返しのあと（差は 0x200 = 512 us）→ デバウンス未満で、数えない
  CHECK(counter.take() == 1);
  counter.onEdge(0x00005000u, 120);       // 折り返しのあと、20 ms 以上 → 数える
  CHECK(counter.take() == 1);

  // ---- 最後のパルスの時刻 ----
  counter.begin(20000, 7777);
  CHECK(counter.lastPulseMs() == 7777);   // 最初のパルスまでは、起動した時刻（起動直後の猶予）
  counter.onEdge(1000, 8888);
  CHECK(counter.lastPulseMs() == 8888);

  // ---- 稼働・停止（時間による判定）----
  CHECK(runningByTime(1000, 1000, 60000));            // 直後
  CHECK(runningByTime(1000, 61000, 60000));           // ちょうど stopMs → 稼働（超えた時点から停止）
  CHECK(!runningByTime(1000, 61001, 60000));          // 1 ms 超えたら停止
  CHECK(runningByTime(0, 9999, 10000));               // 10 秒の設定で、9.999 秒後は稼働
  CHECK(!runningByTime(0, 10001, 10000));
  // millis()（約 49 日）の折り返し
  CHECK(runningByTime(0xFFFFFF00u, 0x00000100u, 1000));      // 差は 512 ms → 稼働
  CHECK(!runningByTime(0xFFFFFF00u, 0x00001000u, 1000));     // 差は約 4.3 秒 → 停止

  // ---- 別の信号（ハイブリッド）: 外部の信号があれば、そちらを優先 ----
  CHECK(isRunning(true, ExternalRun::Unknown));        // 不明なら、時間による判定
  CHECK(!isRunning(false, ExternalRun::Unknown));
  CHECK(isRunning(false, ExternalRun::Running));       // 外部が「稼働」なら、時間では停止でも、稼働
  CHECK(!isRunning(true, ExternalRun::Stopped));       // 外部が「停止」なら、時間では稼働でも、停止

  // ---- 起動直後の猶予（再起動の直後に、偽の「停止」を出さない）----
  PulseCounter fresh;
  fresh.begin(20000, 500000);
  CHECK(runningByTime(fresh.lastPulseMs(), 500000 + 59000, 60000));    // パルスがなくても、60 秒までは稼働
  CHECK(!runningByTime(fresh.lastPulseMs(), 500000 + 61000, 60000));   // 61 秒たったら停止

  std::printf("%d 件の確認のうち、失敗 %d 件\n", checks, failures);
  return failures == 0 ? 0 : 1;
}
