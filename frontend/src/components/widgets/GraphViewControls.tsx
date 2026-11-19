/**
 * グラフの見出しに置く、表示の切り替え（「警報の帯」の入り切り）。端末に覚える（store/useGraphViewStore.ts）。
 *
 * 【誰が使うか】TrendStackWidget（計器グラフの見出し）、SensorGraphWidget（センサーグラフの見出し）。
 * 【引数（props）】なし。設定は store から読み書きする。
 */
import { useGraphViewStore } from "../../store/useGraphViewStore";

export function GraphViewControls() {
  const showBands = useGraphViewStore((s) => s.showBands);
  const setShowBands = useGraphViewStore((s) => s.setShowBands);
  return (
    <span className="inline-flex flex-wrap items-center gap-1.5 text-[11px]">
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
    </span>
  );
}
