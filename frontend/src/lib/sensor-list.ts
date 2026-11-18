/**
 * 設定 › センサーの一覧の、絞り込み・機器ごとのグループ分け・受信の状態の計算。
 *
 * 受信の状態: 最後の受信が 15 分以内なら「受信中」、それより古ければ「止まっている」、まだ受信が無ければ「未受信」。
 * 15 分は全体監視（lib/overview.ts の STALE_MS）と同じ。
 *
 * 【誰が使うか】components/settings/SensorSettingsPanel.tsx。
 */
import { STALE_MS } from "./overview";
import { classifySeverity, type Severity } from "./severity";
import type { Reading, Sensor } from "../types";

export type ReceiveState = "receiving" | "stopped" | "never";
export type ListFilter = "all" | "receiving" | "stopped" | "outside";

/** センサーの受信の状態と、今の値の段階（しきい値の外か） */
export interface SensorLive {
  state: ReceiveState;
  latest: Reading | null;
  level: Severity;
  // 最後の受信からの時間（ミリ秒）。まだ受信が無ければ null
  ageMs: number | null;
}

/** センサー 1 つの、受信の状態を決める */
export function sensorLive(sensor: Sensor, latest: Reading | undefined, now: number): SensorLive {
  if (!latest) return { state: "never", latest: null, level: "normal", ageMs: null };
  const ageMs = Math.max(0, now - new Date(latest.recordedAt).getTime());
  return { state: ageMs > STALE_MS ? "stopped" : "receiving", latest, level: classifySeverity(latest.value, sensor), ageMs };
}

/** しきい値が 1 つでも設定されているか */
export function hasLimits(sensor: Sensor): boolean {
  return [sensor.thresholdMinWarning, sensor.thresholdMinCritical, sensor.thresholdMaxWarning, sensor.thresholdMaxCritical].some((v) => v !== null);
}

/** 名前・取り込みキー・機器の名前に、検索の文字（空白区切りで、すべて含む・大小文字は区別しない）が含まれるか */
export function matchesQuery(sensor: Sensor, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (words.length === 0) return true;
  const target = `${sensor.name} ${sensor.ingestKey} ${sensor.deviceName ?? ""}`.toLowerCase();
  return words.every((word) => target.includes(word));
}

/**
 * 絞り込みのボタンの条件に合うか。
 * 「止まっている」は、受信が古い・まだ受信が無い、の両方。「しきい値の外」は、受信中で、今の値がしきい値の外のもの
 */
export function matchesFilter(filter: ListFilter, _sensor: Sensor, live: SensorLive): boolean {
  if (filter === "receiving") return live.state === "receiving";
  if (filter === "stopped") return live.state !== "receiving";
  if (filter === "outside") return live.state === "receiving" && live.level !== "normal";
  return true;
}

/** 絞り込みのボタンごとの件数（検索の文字は反映する。ボタン自体の条件は、それぞれの数を出すため反映しない） */
export function filterCounts(
  sensors: ReadonlyArray<Sensor>,
  lives: ReadonlyMap<string, SensorLive>,
  query: string,
): Record<ListFilter, number> {
  const counts: Record<ListFilter, number> = { all: 0, receiving: 0, stopped: 0, outside: 0 };
  for (const sensor of sensors) {
    if (!matchesQuery(sensor, query)) continue;
    const live = lives.get(sensor.id);
    if (!live) continue;
    for (const filter of Object.keys(counts) as ListFilter[]) if (matchesFilter(filter, sensor, live)) counts[filter] += 1;
  }
  return counts;
}

/** 機器ごとのまとまり。機器に属さないセンサーは、最後に「機器なし」としてまとめる */
export interface SensorGroup {
  key: string;
  title: string;
  line: string | null;
  sensors: Sensor[];
}

export function groupByDevice(sensors: ReadonlyArray<Sensor>): SensorGroup[] {
  const groups = new Map<string, SensorGroup>();
  for (const sensor of sensors) {
    const key = sensor.deviceId ? `device:${sensor.deviceId}` : "none";
    const group = groups.get(key) ?? { key, title: sensor.deviceName ?? "機器なし", line: sensor.deviceLine ?? null, sensors: [] };
    group.sensors.push(sensor);
    groups.set(key, group);
  }
  // 機器は名前順、機器なしは最後
  return [...groups.values()].sort((a, b) => (a.key === "none" ? 1 : b.key === "none" ? -1 : a.title.localeCompare(b.title, "ja")));
}

/** 一覧の「状態」の列。無効にしたセンサーは、受信に関係なく「無効」 */
export type SensorStatus = "normal" | "outside" | "stopped" | "never" | "disabled";

export function sensorStatus(sensor: Sensor, live: SensorLive): SensorStatus {
  if (!sensor.enabled) return "disabled";
  if (live.state === "never") return "never";
  if (live.state === "stopped") return "stopped";
  return live.level === "normal" ? "normal" : "outside";
}

/**
 * 一覧の「しきい値」の列の文字。正常な範囲を、軽故障のしきい値（無ければ重故障）から作る。
 * 例: 上限 1000 だけ → 「≤ 1000」、下限 18・上限 28 → 「18 — 28」、下限だけ → 「≥ 18」、どれも無し → 「—」
 */
export function thresholdSummary(sensor: Sensor): string {
  const low = sensor.thresholdMinWarning ?? sensor.thresholdMinCritical;
  const high = sensor.thresholdMaxWarning ?? sensor.thresholdMaxCritical;
  if (low !== null && high !== null) return `${low} — ${high}`;
  if (high !== null) return `≤ ${high}`;
  if (low !== null) return `≥ ${low}`;
  return "—";
}

/** 直近 1 時間の区間のデータ（一覧の小さな折れ線と、最低〜最高に使う） */
export interface HourBucket {
  avg: number;
  max: number;
  min: number;
}

/** 区間の min の最低と max の最高（平均の線では丸まる短い山・谷を含める）。データが無ければ null */
export function hourRange(buckets: ReadonlyArray<HourBucket>): { min: number; max: number } | null {
  if (buckets.length === 0) return null;
  return { min: Math.min(...buckets.map((b) => b.min)), max: Math.max(...buckets.map((b) => b.max)) };
}

/** 小さな折れ線に使う区間（始まりの時刻と、区間の平均） */
export interface SparkBucket {
  start: string;
  avg: number;
}

/**
 * 小さな折れ線（sparkline）の線分の並び（それぞれ SVG の polyline の points）。
 * x は区間の中央の時刻（from〜to を 0〜width に置く。範囲の外は端に寄せる）、y は平均の最低〜最高を高さいっぱいに広げる
 * （値がすべて同じなら真ん中）。受信が途切れた所（隣り合う区間の間が、区間の幅の 1.5 倍を超える）では線を切って、空ける。
 * 点が 1 つだけの線分は、短い横線（±1）にして見えるようにする。
 * 例: 1 時間 = 0〜100 のとき、区間（120 秒）が 0 分と 2 分にあって、30 分の次が 40 分 → 線分は 2 本
 */
export function sparkSegments(
  buckets: ReadonlyArray<SparkBucket>,
  bucketSeconds: number,
  from: number,
  to: number,
  width: number,
  height: number,
): string[] {
  if (buckets.length === 0 || to <= from) return [];
  const values = buckets.map((bucket) => bucket.avg);
  const low = Math.min(...values);
  const span = Math.max(...values) - low;
  const half = (bucketSeconds * 1000) / 2;
  const points = buckets.map((bucket) => {
    const time = new Date(bucket.start).getTime() + half;
    const x = Math.min(width, Math.max(0, ((time - from) / (to - from)) * width));
    const y = span === 0 ? height / 2 : height - ((bucket.avg - low) / span) * height;
    return { time, x, y };
  });
  const fmt = (p: { x: number; y: number }) => `${p.x.toFixed(1)},${p.y.toFixed(1)}`;
  const segments: Array<typeof points> = [];
  for (const point of points) {
    const last = segments[segments.length - 1];
    const previous = last?.[last.length - 1];
    if (last && previous && point.time - previous.time <= bucketSeconds * 1000 * 1.5) last.push(point);
    else segments.push([point]);
  }
  return segments.map((segment) => {
    if (segment.length > 1) return segment.map(fmt).join(" ");
    const [only] = segment;
    return `${fmt({ x: Math.max(0, only.x - 1), y: only.y })} ${fmt({ x: Math.min(width, only.x + 1), y: only.y })}`;
  });
}

/** 一覧・詳細の「今の値」の文字。100 以上は整数、それ未満は小数 2 桁まで（末尾の 0 は付けない）。例: 1092.4 → 1092、22.1 → 22.1、0.5 → 0.5 */
export function formatLiveValue(value: number): string {
  return String(Math.abs(value) >= 100 ? Math.round(value) : Number(value.toFixed(2)));
}
