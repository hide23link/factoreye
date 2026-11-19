/**
 * グラフの見出しに置く、表示の切り替え（「警報の帯」の入り切りと、「比較: なし / 昨日 / 先週」）。端末に覚える（store/useGraphViewStore.ts）。
 * 比較は、保持期間の外になる範囲では押せなくして、理由を出す（title と、ボタンの下の説明）。
 *
 * 【誰が使うか】TrendStackWidget（計器グラフの見出し）、SensorGraphWidget（センサーグラフの見出し）。
 * 【引数（props）】rangeFrom = 表示範囲の始め（ミリ秒。比較で、さらに前に出ても保持期間に収まるかの判定に使う）。
 * nowMs = 今の時刻（ミリ秒）。compareDisabledReason = 保持期間以外の理由で比較を使えないときの説明（無ければ省く。例: 棒グラフ）。
 */
import { COMPARE_OPTIONS, compareAvailability } from "../../lib/compare-range";
import { maxRangeForBuild } from "../../lib/timeRange";
import { useGraphViewStore } from "../../store/useGraphViewStore";

export function GraphViewControls({ rangeFrom, nowMs, compareDisabledReason }: { rangeFrom: number; nowMs: number; compareDisabledReason?: string }) {
  const showBands = useGraphViewStore((s) => s.showBands);
  const setShowBands = useGraphViewStore((s) => s.setShowBands);
  const compare = useGraphViewStore((s) => s.compare);
  const setCompare = useGraphViewStore((s) => s.setCompare);
  // 押せない選択肢の理由（最初の 1 つを、下に出す）
  const reasons = COMPARE_OPTIONS.map((option) => ({
    mode: option.mode,
    // 「なし」はいつでも選べる
    reason: option.mode === "none" ? null : (compareDisabledReason ?? compareAvailability(option.mode, rangeFrom, nowMs, maxRangeForBuild()).reason),
  }));
  const shownReason = reasons.find((r) => r.reason !== null && r.mode === compare)?.reason ?? reasons.find((r) => r.reason !== null)?.reason ?? null;
  return (
    <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1 text-[11px]">
      <button
        type="button"
        aria-pressed={showBands}
        aria-label="警報の帯を表示する"
        title="しきい値を超えた時間を、縦の帯で重ねる"
        onClick={() => setShowBands(!showBands)}
        className="rounded border px-1.5 font-bold hover:opacity-80"
        style={{ borderColor: showBands ? "var(--fe-amb)" : "var(--fe-line)", color: showBands ? "var(--fe-amb)" : "var(--fe-mut)" }}
      >
        警報の帯 {showBands ? "入" : "切"}
      </button>
      <span role="group" aria-label="比較" className="inline-flex items-center gap-1">
        <span style={{ color: "var(--fe-mut)" }}>比較</span>
        {COMPARE_OPTIONS.map((option) => {
          const reason = reasons.find((r) => r.mode === option.mode)?.reason ?? null;
          const selected = compare === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              aria-pressed={selected}
              aria-label={`比較: ${option.label}`}
              disabled={reason !== null}
              title={reason ?? (option.mode === "none" ? "比較の線を出さない" : `${option.label}の同じ時間帯を、灰色の点線で重ねる`)}
              onClick={() => setCompare(option.mode)}
              className="rounded border px-1.5 font-bold hover:opacity-80 disabled:cursor-not-allowed disabled:opacity-40"
              style={{ borderColor: selected ? "var(--fe-ink)" : "var(--fe-line)", color: selected ? "var(--fe-ink)" : "var(--fe-mut)" }}
            >
              {option.label}
            </button>
          );
        })}
      </span>
      {shownReason && (
        <span role="note" style={{ color: "var(--fe-amb)" }}>
          {shownReason}
        </span>
      )}
    </span>
  );
}
