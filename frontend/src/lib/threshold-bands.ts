/**
 * しきい値を超えている区間を、連続した 1 つの「帯」にまとめる計算（グラフに縦の帯を重ねるための元データ）。
 *
 * 判定は、グラフの線の色の切り替えと同じ levelOf（lib/trend-stack.ts）を、線と同じ点に使う。
 * そのため、線が橙・赤に変わる所と、帯の端は一致する（警報の記録 alarms 表は使わない。表と食い違うのを避けるため）。
 * 間引きで 1 点だけ超えた場合も、1 点の帯（startMs = endMs）になる。描くときに幅は最低 2px にする。
 *
 * 【誰が使うか】components/widgets/TrendStackWidget.tsx（計器グラフの各行）と SensorGraphWidget.tsx（センサーグラフ）。
 * 【引数】points = 線の点（時刻の昇順）。limits = trendLimits(sensor) の結果。gapMs = これより点が離れたら受信なしとみなして帯を分ける。
 * 例: 点が 11:00 正常・11:10 注意(41)・11:20 警報(45)・11:30 正常 なら、
 *     [{ startMs: 11:10, endMs: 11:20, level: "critical", side: "max", extreme: 45 }]
 */
import { levelOf, type TrendLimit, type TrendPoint } from "./trend-stack";

/** 帯の段階。注意（軽故障）は橙、警報（重故障）は赤で描く */
export type BandLevel = "warning" | "critical";

/** 超えた区間 1 つ */
export interface AlarmBand {
  startMs: number;
  endMs: number;
  /** 区間の中の最悪の段階 */
  level: BandLevel;
  /** どちら側を超えたか（上限側＝max、下限側＝min） */
  side: "max" | "min";
  /** 区間の中でいちばん深く超えた値（上限側は最高、下限側は最低） */
  extreme: number;
}

/** 点が限界をどれだけ超えているか（超えていなければ 0）。上限側は value - 限界、下限側は 限界 - value */
function excessOf(value: number, limits: ReadonlyArray<TrendLimit>): { amount: number; side: "max" | "min" } {
  let best = { amount: 0, side: "max" as "max" | "min" };
  for (const limit of limits) {
    const amount = limit.side === "max" ? value - limit.value : limit.value - value;
    if (amount > best.amount) best = { amount, side: limit.side };
  }
  return best;
}

/** しきい値を超えている連続した区間の一覧（時刻の昇順）。しきい値が無い・超えていなければ空 */
export function computeBands(points: ReadonlyArray<TrendPoint>, limits: ReadonlyArray<TrendLimit>, gapMs = Infinity): AlarmBand[] {
  if (limits.length === 0) return [];
  const bands: AlarmBand[] = [];
  let current: (AlarmBand & { depth: number }) | null = null;
  let previousTime = -Infinity;

  for (const point of points) {
    const level = levelOf(point.value, limits);
    if (level === "normal") {
      current = null;
      previousTime = point.time;
      continue;
    }
    const excess = excessOf(point.value, limits);
    const continues = current !== null && point.time - previousTime <= gapMs;
    if (!continues || current === null) {
      current = { startMs: point.time, endMs: point.time, level, side: excess.side, extreme: point.value, depth: excess.amount };
      bands.push(current);
    } else {
      current.endMs = point.time;
      if (level === "critical") current.level = "critical";
      // いちばん深く超えた点の値と側を、帯の「最高・最低」にする
      if (excess.amount > current.depth) {
        current.depth = excess.amount;
        current.side = excess.side;
        current.extreme = point.value;
      }
    }
    previousTime = point.time;
  }
  // depth は計算用なので、返す形からは外す
  return bands.map(({ startMs, endMs, level, side, extreme }) => ({ startMs, endMs, level, side, extreme }));
}

/**
 * 時刻（カーソル）がある帯。無ければ null。
 * toleranceMs: 帯の端からこの長さまでは、帯の中とみなす（カーソルは 1 区間に丸めるので、1 点だけの帯にも触れるように）。
 */
export function bandAt(bands: ReadonlyArray<AlarmBand>, time: number, toleranceMs = 0): AlarmBand | null {
  return bands.find((band) => time >= band.startMs - toleranceMs && time <= band.endMs + toleranceMs) ?? null;
}

/** 帯の説明の文字。例: 「警報 11:42〜12:58 最高 89.2」「注意 03:10 最低 4.1」（1 点だけの帯は時刻を 1 つだけ出す） */
export function describeBand(band: AlarmBand, formatTime: (ms: number) => string, formatValue: (value: number) => string): string {
  const name = band.level === "critical" ? "警報" : "注意";
  const range = band.startMs === band.endMs ? formatTime(band.startMs) : `${formatTime(band.startMs)}〜${formatTime(band.endMs)}`;
  return `${name} ${range} ${band.side === "max" ? "最高" : "最低"} ${formatValue(band.extreme)}`;
}
