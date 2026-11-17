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
export type ListFilter = "all" | "receiving" | "stopped" | "limits";

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

/** 絞り込みのボタンの条件に合うか（「止まっている」は、受信が古い・まだ受信が無い、の両方） */
export function matchesFilter(filter: ListFilter, sensor: Sensor, live: SensorLive): boolean {
  if (filter === "receiving") return live.state === "receiving";
  if (filter === "stopped") return live.state !== "receiving";
  if (filter === "limits") return hasLimits(sensor);
  return true;
}

/** 絞り込みのボタンごとの件数（検索の文字は反映する。ボタン自体の条件は、それぞれの数を出すため反映しない） */
export function filterCounts(
  sensors: ReadonlyArray<Sensor>,
  lives: ReadonlyMap<string, SensorLive>,
  query: string,
): Record<ListFilter, number> {
  const counts: Record<ListFilter, number> = { all: 0, receiving: 0, stopped: 0, limits: 0 };
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
