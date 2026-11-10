/**
 * グラフに描く「行」（時刻ごとに、各センサーの値を並べた表）を作る。
 * 区間の値の選び方（平均・最大・最小）、積み上げのための欠けの補い、センサーごとの 0〜100% への換算をここで行う。
 *
 * 【誰が使うか】MultiSensorComparisonWidget、SensorGraphWidget、GraphLinkView（今の値・タップした時刻の値）。
 */
import type { DownsampledBucket } from "./api";
import type { Aggregation } from "./graph-config";

/** 1行分。time は区間の中央の時刻（ミリ秒）、そのほかのキーはセンサー ID（値）か、ID + RAW_SUFFIX（換算前の値） */
export type GraphRow = { time: number } & Record<string, number>;

/** 0〜100% にそろえたときの、元の値を持つキーの末尾。ツールチップで元の値を出すのに使う */
export const RAW_SUFFIX = "__raw";

export function bucketValue(bucket: Pick<DownsampledBucket, "avg" | "max" | "min">, aggregation: Aggregation): number {
  return aggregation === "max" ? bucket.max : aggregation === "min" ? bucket.min : bucket.avg;
}

export interface SeriesInput {
  sensorId: string;
  bucketSeconds: number;
  buckets: ReadonlyArray<Pick<DownsampledBucket, "start" | "avg" | "max" | "min">>;
}

/**
 * 区間の中央の時刻ごとに、各センサーの値を1行にまとめる（同じ時刻は同じ行に入る）。
 * fillGaps は、積み上げ用。そのセンサーの最初〜最後のデータのあいだで値が無い行は、直前の値で埋める（欠けたまま積み上げると、積み上がりが途切れるため）。
 * 最初のデータより前と、最後のデータより後（止まったセンサー）は、実際の値のように見えないよう 0 にする。
 */
export function buildRows(
  inputs: ReadonlyArray<SeriesInput>,
  aggregation: Aggregation,
  options: { fillGaps?: boolean } = {},
): GraphRow[] {
  const byTime = new Map<number, GraphRow>();
  for (const input of inputs) {
    const halfBucketMs = (input.bucketSeconds * 1000) / 2;
    for (const bucket of input.buckets) {
      const time = new Date(bucket.start).getTime() + halfBucketMs;
      const row = byTime.get(time) ?? ({ time } as GraphRow);
      row[input.sensorId] = bucketValue(bucket, aggregation);
      byTime.set(time, row);
    }
  }
  const rows = Array.from(byTime.values()).sort((a, b) => a.time - b.time);
  if (options.fillGaps) {
    for (const { sensorId } of inputs) {
      const lastIndex = rows.reduce((last, row, index) => (row[sensorId] !== undefined ? index : last), -1);
      let previous = 0;
      rows.forEach((row, index) => {
        if (row[sensorId] !== undefined) previous = row[sensorId];
        else row[sensorId] = index < lastIndex ? previous : 0;
      });
    }
  }
  return rows;
}

/**
 * センサーごとに、表示している範囲の最小〜最大を 0〜100 に換算する（単位の違うセンサーを同じ高さで比べるため）。
 * 値が変わらないセンサー（最小 = 最大）は、真ん中（50）に置く。元の値は ID + RAW_SUFFIX に残す。
 */
export function normalizeRows(rows: ReadonlyArray<GraphRow>, sensorIds: ReadonlyArray<string>): GraphRow[] {
  const ranges = new Map<string, { low: number; high: number }>();
  for (const id of sensorIds) {
    const values = rows.map((r) => r[id]).filter((v): v is number => v !== undefined);
    if (values.length > 0) ranges.set(id, { low: Math.min(...values), high: Math.max(...values) });
  }
  return rows.map((row) => {
    const next = { ...row } as GraphRow;
    for (const id of sensorIds) {
      const raw = row[id];
      const range = ranges.get(id);
      if (raw === undefined || !range) continue;
      next[id] = range.high === range.low ? 50 : ((raw - range.low) / (range.high - range.low)) * 100;
      next[id + RAW_SUFFIX] = raw;
    }
    return next;
  });
}

/** 0〜100% にそろえたグラフのツールチップに出す、元の値（換算前）。無ければ undefined */
export function rawValueOf(item: { dataKey?: unknown; payload?: unknown }): number | undefined {
  const raw = (item.payload as Record<string, unknown> | undefined)?.[`${String(item.dataKey)}${RAW_SUFFIX}`];
  return typeof raw === "number" ? raw : undefined;
}

/**
 * ある時刻にいちばん近い行の、そのセンサーの値（リンクの画面で、今の値・タップした時刻の値を出すため）。
 * そのセンサーの値がある行だけから選ぶ。1 つも無ければ null。
 */
export function nearestValue(rows: ReadonlyArray<GraphRow>, sensorId: string, at: number): number | null {
  let best: number | null = null;
  let bestGap = Number.POSITIVE_INFINITY;
  for (const row of rows) {
    const value = row[sensorId];
    if (value === undefined) continue;
    const gap = Math.abs(row.time - at);
    if (gap < bestGap) {
      best = value;
      bestGap = gap;
    }
  }
  return best;
}
