/**
 * センサー棚の「機器ごと」の並べ方に使う、グループ分けと検索の部品（画面を持たない計算だけ）。
 *
 * 【誰が使うか】EditorShelf。
 * 機器（取り込みの機器）に所属するセンサーは機器ごとに、所属しないものは「未所属」にまとめる。
 */
import type { Sensor } from "../types";

/** 機器に所属しないセンサーのグループの id と、画面に出す名前 */
export const NO_DEVICE_GROUP_ID = "no-device";
export const NO_DEVICE_GROUP_NAME = "未所属";

export interface SensorGroup {
  /** 開閉の記録に使う id（機器の id。未所属は NO_DEVICE_GROUP_ID） */
  id: string;
  name: string;
  sensors: Sensor[];
}

/** 機器の名前の並びは、数字の大きさで比べる（r-load-2 が r-load-10 より前に来る） */
const compareNames = new Intl.Collator("ja", { numeric: true }).compare;

/** 機器に所属するセンサーが 1 つでもあるか（無ければ「機器ごと」の並べ方は意味がない） */
export function hasDevices(sensors: Sensor[]): boolean {
  return sensors.some((s) => Boolean(s.deviceId));
}

/** 機器ごとに分ける。機器の名前順に並べ、「未所属」は最後。センサーの順番は、渡された順のまま */
export function groupByDevice(sensors: Sensor[]): SensorGroup[] {
  const groups = new Map<string, SensorGroup>();
  for (const sensor of sensors) {
    const id = sensor.deviceId ?? NO_DEVICE_GROUP_ID;
    let group = groups.get(id);
    if (!group) {
      group = { id, name: sensor.deviceName ?? NO_DEVICE_GROUP_NAME, sensors: [] };
      groups.set(id, group);
    }
    group.sensors.push(sensor);
  }
  return [...groups.values()].sort((a, b) => {
    if (a.id === NO_DEVICE_GROUP_ID) return 1;
    if (b.id === NO_DEVICE_GROUP_ID) return -1;
    return compareNames(a.name, b.name);
  });
}

/**
 * 検索の文字（小文字にしたもの）に合うか。機器の名前に合えば、その機器のセンサーはすべて合う。
 * 文字が空なら、すべて合う。
 */
export function matchesQuery(sensor: Sensor, needle: string): boolean {
  if (needle === "") return true;
  const device = sensor.deviceName ?? "";
  return `${sensor.name} ${sensor.ingestKey} ${device}`.toLowerCase().includes(needle);
}

/** 未対応のアラームの重さ（グループの見出しの点に使う）。重いほうを残す */
export type AlertLevel = "critical" | "warning" | "none";

export function worstLevel(sensors: Sensor[], levelBySensor: ReadonlyMap<string, AlertLevel>): AlertLevel {
  let worst: AlertLevel = "none";
  for (const sensor of sensors) {
    const level = levelBySensor.get(sensor.id) ?? "none";
    if (level === "critical") return "critical";
    if (level === "warning") worst = "warning";
  }
  return worst;
}

/** チェックの状態: 全部 / 一部 / なし（見出しのチェックボックスの表示に使う） */
export type CheckState = "all" | "some" | "none";

export function checkStateOf(sensors: Sensor[], selectedIds: ReadonlySet<string>): CheckState {
  const count = sensors.filter((s) => selectedIds.has(s.id)).length;
  if (count === 0) return "none";
  return count === sensors.length ? "all" : "some";
}
