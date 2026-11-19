/**
 * グラフの取得データ（間引き API の結果）から、「表」と「CSV の行」を作る。
 * 表も CSV も同じ取得データから作るので、行数はグラフの点の数と一致する。
 *
 * 時刻は、間引きの区間の開始時刻（bucket.start）。複数のセンサーは、同じ範囲・同じ区間数で取るので
 * 区間の開始時刻がそろう。そろわないときは、時刻の和集合にして、無い欄は空にする。
 *
 * 画面（React）に依存しない関数だけを置く。
 *
 * 【誰が使うか】WidgetTable（表）、WidgetMenu（CSV を保存）。
 */
import type { DownsampledBucket } from "./api";
import type { Aggregation } from "./graph-config";
import { bucketValue } from "./graph-series";
import { toJstFileStamp, toJstIso } from "./csv";
import { LINK_MAX_MINUTES, LINK_MIN_MINUTES } from "./graph-link";
import { PRESETS, type ResolvedRange, type TimeRange } from "./timeRange";

/** 1 本の線（センサー）の取得結果。name・unit は列の見出しに使う */
export interface TableSeries {
  name: string;
  unit: string;
  buckets: ReadonlyArray<Pick<DownsampledBucket, "start" | "avg" | "max" | "min">>;
}

/** 表の 1 行。timeMs = 区間の開始、values = 線ごとの値（無ければ null。series と同じ並び） */
export interface TableRow {
  timeMs: number;
  values: Array<number | null>;
}

/** 列の見出し「名前 (単位)」。単位が無ければ名前だけ */
export function columnTitle(series: Pick<TableSeries, "name" | "unit">): string {
  return series.unit ? `${series.name} (${series.unit})` : series.name;
}

/** 取得データから行を作る。古い順。値は aggregation（平均・最大・最小）で選ぶ */
export function buildTableRows(series: ReadonlyArray<TableSeries>, aggregation: Aggregation): TableRow[] {
  const byTime = new Map<number, Array<number | null>>();
  series.forEach((one, index) => {
    for (const bucket of one.buckets) {
      const timeMs = new Date(bucket.start).getTime();
      if (!Number.isFinite(timeMs)) continue;
      let values = byTime.get(timeMs);
      if (!values) {
        values = series.map(() => null);
        byTime.set(timeMs, values);
      }
      values[index] = bucketValue(bucket, aggregation);
    }
  });
  return [...byTime.entries()].sort((a, b) => a[0] - b[0]).map(([timeMs, values]) => ({ timeMs, values }));
}

/** CSV の行（1 行目は見出し: 「時刻(JST,ISO 8601)」と「名前 (単位)」。続きは古い順のデータ） */
export function buildCsvRows(series: ReadonlyArray<TableSeries>, rows: ReadonlyArray<TableRow>): Array<Array<string | number | null>> {
  return [
    ["時刻(JST,ISO 8601)", ...series.map(columnTitle)],
    ...rows.map((row) => [toJstIso(row.timeMs), ...row.values]),
  ];
}

/** 表示用の時刻（JST。例: 11-20 14:05:00） */
export function formatTableTime(ms: number): string {
  return toJstIso(ms).slice(5, 19).replace("T", " ");
}

/** 表示用の値。小数は 3 桁までに丸める（値が無ければ「-」） */
export function formatTableValue(value: number | null): string {
  return value === null ? "-" : String(Math.round(value * 1000) / 1000);
}

/** ファイル名に使う期間の文字。直近のプリセットは「直近1時間」、それ以外の直近は「直近90分」、固定の期間は「開始_終了」（JST） */
export function periodLabel(range: TimeRange, bounds: ResolvedRange): string {
  if (range.mode === "relative") {
    const preset = PRESETS.find((p) => p.durationMs === range.durationMs);
    return preset ? preset.label.replace(/\s/g, "") : `直近${Math.round(range.durationMs / 60000)}分`;
  }
  return `${toJstFileStamp(bounds.from)}-${toJstFileStamp(bounds.to)}`;
}

/** 「この期間のリンク」の直近の分数。リンクの範囲（10〜10080 分）に収める。固定の期間は、その長さを使う */
export function linkMinutes(range: TimeRange, bounds: ResolvedRange): number {
  const ms = range.mode === "relative" ? range.durationMs : bounds.to - bounds.from;
  return Math.min(LINK_MAX_MINUTES, Math.max(LINK_MIN_MINUTES, Math.round(ms / 60000)));
}
