/**
 * ふつうのグラフ（SensorGraph）・複数のグラフ（MultiSensorComparison）に、共有のカーソル（useCursorTimeStore）を出す部品。
 * 計器グラフ（TrendStack）のカーソルと同じ時刻に縦線が動き、縦線の真下（時間の軸の行）に、時刻の札を出す。
 *
 * - SharedCursorOverlay: グラフ（LineChart など）の子に置く。縦線と時刻の札を描く（何も操作しない）
 * - CursorResetButton: カーソルを動かしたあとだけ出る「今に戻す」ボタン
 *
（マウスを動かしたときに共有の時刻を更新するイベントは、lib/shared-cursor.ts の withSharedCursor）
 *
 * 【誰が使うか】SensorGraphWidget・MultiSensorComparisonWidget（リンクの画面では使わない。リンクが時刻を持つ）。
 */
import { useXAxisScale, usePlotArea } from "recharts";

import { estimateTextWidth, formatTickTime, shownCursorTime } from "../../lib/trend-stack";
import { useCursorTimeStore } from "../../store/useCursorTimeStore";

/** 時刻の札の文字の大きさ（px）と、札の高さ・上のすきま */
const TIME_FONT_PX = 11;
const TIME_BOX_HEIGHT = 16;

/**
 * グラフの子に置く。共有の時刻に縦線を引き、縦線の真下（時間の軸の目盛りの行）に、時刻の札を出す（目盛りの文字より札を優先）。
 * 札は、グラフの左端・右端では内側に寄せる。
 * 【引数】from・to = このグラフの表示範囲（ミリ秒）。共有の時刻が範囲の外なら、範囲の端に収める。
 */
export function SharedCursorOverlay({ from, to }: { from: number; to: number }) {
  const time = useCursorTimeStore((s) => s.time);
  const xScale = useXAxisScale();
  const plot = usePlotArea();
  if (!xScale || !plot) return null;
  const shown = shownCursorTime(time, from, to);
  const x = xScale(shown);
  if (typeof x !== "number" || !Number.isFinite(x)) return null;

  const text = formatTickTime(shown, to - from);
  const width = estimateTextWidth(text, TIME_FONT_PX) + 12;
  const left = Math.min(Math.max(x - width / 2, plot.x), Math.max(plot.x, plot.x + plot.width - width));
  const top = plot.y + plot.height + 2;
  return (
    <g data-testid="shared-cursor" pointerEvents="none">
      <line x1={x} x2={x} y1={plot.y} y2={plot.y + plot.height} style={{ stroke: "var(--fe-cursor)" }} strokeWidth={1} />
      <rect x={left} y={top} width={width} height={TIME_BOX_HEIGHT} rx={2} style={{ fill: "var(--fe-ink)" }} />
      <text
        x={left + width / 2}
        y={top + 12}
        textAnchor="middle"
        fontSize={TIME_FONT_PX}
        fontWeight={700}
        className="font-num"
        style={{ fill: "var(--fe-panel)" }}
      >
        {text}
      </text>
    </g>
  );
}

/**
 * カーソルを動かしたあとだけ出る「今に戻す」ボタン（共有の時刻を、現在位置に戻す）。
 * グラフの右上に重ねて置く（親は relative にする）。カーソルを動かしたグラフ（widgetId）にだけ出す。
 */
export function CursorResetButton({ widgetId }: { widgetId: string }) {
  const moved = useCursorTimeStore((s) => s.time !== null && (s.owner === null || s.owner === widgetId));
  const reset = useCursorTimeStore((s) => s.reset);
  if (!moved) return null;
  return (
    <button
      type="button"
      onClick={reset}
      title="すべてのグラフのカーソルを、現在位置（右端）に戻す"
      // 色は画面の明るさに合わせた変数（暗い画面でも白く浮かない）
      style={{ borderColor: "var(--fe-line)", background: "var(--fe-chrome)", color: "var(--fe-ink)" }}
      className="absolute right-0 top-0 z-10 rounded border px-1.5 py-0.5 text-[10px] font-bold hover:opacity-80"
    >
      カーソルを今に戻す
    </button>
  );
}
