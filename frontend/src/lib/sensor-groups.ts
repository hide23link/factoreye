/**
 * センサー棚の「機器ごと」「系統 › 機器」の並べ方に使う、グループ分けと検索の部品（画面を持たない計算だけ）。
 *
 * 【誰が使うか】EditorShelf。
 * 機器（取り込みの機器）に所属するセンサーは機器ごとに、所属しないものは「未所属」にまとめる。
 * 「系統 › 機器」では、機器をさらに系統（機器の任意の項目。例: 第1ライン）にまとめ、系統のない機器は「系統なし」に入れる。
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

/** 系統のない機器（と、機器に所属しないセンサー）をまとめる系統の id と、画面に出す名前 */
export const NO_LINE_GROUP_ID = "no-line";
export const NO_LINE_GROUP_NAME = "系統なし";

/** 系統のグループ。sensors は系統全体のセンサー、devices はその中の機器ごとのグループ */
export interface LineGroup extends SensorGroup {
  devices: SensorGroup[];
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

/** 系統を持つ機器のセンサーが 1 つでもあるか（無ければ「系統 › 機器」の並べ方は意味がない） */
export function hasLines(sensors: Sensor[]): boolean {
  return sensors.some((s) => Boolean(s.deviceLine));
}

/**
 * 系統 › 機器 に分ける。系統の名前順（数字は大きさで比べる）に並べ、「系統なし」は最後。
 * 系統のない機器、機器に所属しないセンサー（「未所属」）は、「系統なし」に入る。
 */
export function groupByLine(sensors: Sensor[]): LineGroup[] {
  // キーが null のものが「系統なし」（名前の文字では見分けない。利用者が同じ名前の系統を付けても混ざらない）
  const byLine = new Map<string | null, Sensor[]>();
  for (const sensor of sensors) {
    const line = sensor.deviceLine || null;
    const members = byLine.get(line);
    if (members) members.push(sensor);
    else byLine.set(line, [sensor]);
  }
  const lines = [...byLine].map(
    ([line, members]): LineGroup => ({
      id: line === null ? NO_LINE_GROUP_ID : `line:${line}`,
      name: line ?? NO_LINE_GROUP_NAME,
      sensors: members,
      devices: groupByDevice(members),
    }),
  );
  return lines.sort((a, b) => {
    if (a.id === NO_LINE_GROUP_ID) return 1;
    if (b.id === NO_LINE_GROUP_ID) return -1;
    return compareNames(a.name, b.name);
  });
}

/**
 * 検索の文字（小文字にしたもの）に合うか。機器・系統の名前に合えば、その機器・系統のセンサーはすべて合う。
 * 文字が空なら、すべて合う。
 */
export function matchesQuery(sensor: Sensor, needle: string): boolean {
  if (needle === "") return true;
  const device = sensor.deviceName ?? "";
  const line = sensor.deviceLine ?? "";
  return `${sensor.name} ${sensor.ingestKey} ${device} ${line}`.toLowerCase().includes(needle);
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

/**
 * センサーの名前に、語を含むか（大文字小文字を区別しない。検索と同じ）。word が null なら、すべて合う。
 * 「電圧」「電流」のように、名前の付け方で分ける絞り込みに使う（機器の項目ではなく名前だけを見る）。
 */
export function matchesWord(sensor: Sensor, word: string | null): boolean {
  return word === null || sensor.name.toLowerCase().includes(word.toLowerCase());
}

/** 語ごとの、名前に含むセンサーの数（渡したセンサー全体で数える。チップの件数に使う） */
export function countByWord(sensors: Sensor[], words: readonly string[]): Map<string, number> {
  return new Map(words.map((word) => [word, sensors.filter((s) => matchesWord(s, word)).length]));
}
