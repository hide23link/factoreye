/**
 * グラフの右に並べる、今の値の札（操作室の計器のように、四角で囲んだ等幅の数字）。
 * 線ごとに 1 つ。枠と左の小さな矢印（◀）の色は、その線の色。
 * 札は、その線の最後の点の高さに置き、矢印でその点を指す（画面刷新モックと同じ形）。
 * 値が近くて札が重なるときは、上下にずらす（矢印は元の高さを指したまま）。
 * 値は、全センサーの最新の測定値（GET /api/sensors/latest）。まだ受信が無いセンサーは「---」。
 *
 * 【誰が使うか】SensorGraphWidget（1 センサー）、MultiSensorComparisonWidget（複数）。リンクの画面では出さない。
 * 【使い方】
 *   const [measure, setMeasure] = useGraphValueMeasure();   ← hooks/useGraphValueMeasure.ts
 *   <LineChart>… <GraphValueProbe items={items} onMeasure={setMeasure} /></LineChart>   ← グラフの中で高さを測る
 *   <GraphValues items={items} measure={measure} />                                       ← グラフの右に札を出す
 * 【引数（props）】items = 線ごとの {名前・色・単位・今の値・札を置く高さの値・縦軸}。値の桁は decimals（未指定は有効数字 4 桁）。
 */
import { useEffect } from "react";
import { useChartHeight, usePlotArea, useYAxisScale } from "recharts";
import { formatYTick } from "./graph-parts";
import { layoutValueTags } from "../../lib/graph-value-tags";
import type { GraphValueMeasure } from "../../hooks/useGraphValueMeasure";

export interface GraphValueItem {
  name: string;
  color: string;
  unit: string;
  /** 最新の測定値。まだ受信が無いときは undefined */
  value: number | undefined;
  /** 札を置く高さの、グラフの値（ふつうは value と同じ。0〜100% にそろえたグラフでは換算後の値）。分からないときは undefined */
  position?: number;
  /** その線が載る縦軸（左右の 2 軸のときの "left" / "right"）。1 つの軸なら undefined */
  yAxisId?: string;
}

/**
 * グラフ（LineChart など）の中に置いて、各線の最後の点の高さを測る。何も描かない。
 * 縦軸の目盛りと同じ計算（recharts の縦軸）で px に直すので、線の位置と一致する。
 */
export function GraphValueProbe({
  items,
  onMeasure,
}: {
  items: ReadonlyArray<GraphValueItem>;
  onMeasure: (measure: GraphValueMeasure) => void;
}) {
  // 縦軸は、1 つ（既定）か、左右の 2 つ。フックは毎回同じ数だけ呼ぶ
  const scales = {
    default: useYAxisScale(),
    left: useYAxisScale("left"),
    right: useYAxisScale("right"),
  };
  const plot = usePlotArea();
  const height = useChartHeight();

  const ys = items.map((item) => {
    const scale = item.yAxisId === "left" || item.yAxisId === "right" ? scales[item.yAxisId] : scales.default;
    if (!scale || !plot || item.position === undefined || !Number.isFinite(item.position)) return undefined;
    const y = scale(item.position);
    if (typeof y !== "number" || !Number.isFinite(y)) return undefined;
    // 縦軸の範囲の外の値は、グラフの上端・下端に寄せる
    return Math.round(Math.min(plot.y + plot.height, Math.max(plot.y, y)));
  });
  // 配列は毎回作り直されるので、文字列にして変わったときだけ知らせる
  const key = JSON.stringify(ys);
  useEffect(() => {
    if (height) onMeasure({ height, ys: JSON.parse(key) as Array<number | undefined> });
  }, [height, key, onMeasure]);
  return null;
}

export function GraphValues({
  items,
  decimals,
  measure,
}: {
  items: ReadonlyArray<GraphValueItem>;
  decimals?: number;
  measure?: GraphValueMeasure;
}) {
  const format = (value: number | undefined) =>
    value === undefined ? "---" : decimals === undefined ? formatYTick(value) : value.toFixed(decimals);
  // 札の下の小さな文字。1 つのセンサーなら単位だけ、複数なら名前と単位
  const caption = (item: GraphValueItem) => (items.length > 1 ? `${item.name} ${item.unit}`.trim() : item.unit);

  // まだ測れていない（グラフの描画前・試験の環境）ときは、縦に並べるだけ
  if (!measure || measure.ys.length !== items.length) {
    return (
      <ul className="flex w-[76px] shrink-0 flex-col justify-center gap-1.5" aria-label="今の値">
        {items.map((item) => (
          <li key={item.name} className="flex flex-col items-end">
            <span
              className="max-w-full truncate rounded-sm border-[1.5px] px-1 text-right font-num text-sm font-bold text-gray-900"
              style={{ borderColor: item.color }}
              title={item.name}
            >
              {format(item.value)}
            </span>
            <span className="max-w-full truncate text-[10px] text-gray-500" title={item.name}>
              {caption(item)}
            </span>
          </li>
        ))}
      </ul>
    );
  }

  const tops = layoutValueTags(measure.ys, measure.height);
  return (
    <ul className="relative w-[76px] shrink-0" aria-label="今の値">
      {items.map((item, i) => {
        const top = tops[i];
        const y = measure.ys[i];
        // 矢印の先（札の上端からの px）。札をずらしても、元の点の高さを指す
        const tip = y === undefined ? undefined : y - top;
        return (
          <li key={item.name} className="absolute left-0 right-0 flex flex-col items-end" style={{ top }}>
            {tip !== undefined && (
              <svg data-testid="graph-value-arrow" aria-hidden="true" className="absolute -left-2 top-0 overflow-visible" width={8} height={20}>
                <polygon
                  points={`0,${tip} 8,${Math.min(15, Math.max(0, tip - 5))} 8,${Math.min(20, Math.max(5, tip + 5))}`}
                  fill={item.color}
                />
              </svg>
            )}
            <span
              className="block h-5 w-full truncate rounded-sm border-[1.5px] px-1 text-right font-num text-sm font-bold leading-4 text-gray-900"
              style={{ borderColor: item.color }}
              title={item.name}
            >
              {format(item.value)}
            </span>
            <span className="h-3 max-w-full truncate text-[10px] leading-3 text-gray-500" title={item.name}>
              {caption(item)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
