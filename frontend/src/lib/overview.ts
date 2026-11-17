/**
 * 全体監視（管制塔のように、全部の機器の様子を 1 画面で見る）の計算。
 * 機器ごと（機器に属さないセンサーは 1 つずつ）に「札」を作り、警報・注意・正常・未受信の欄に分ける。
 *
 * 札の状態の決め方（上ほど優先）:
 * - 警報: 重故障のアラームが未解決、または最新の値が重故障のしきい値の外
 * - 注意: 軽故障のアラームが未解決、最新の値が軽故障のしきい値の外、またはどれかのセンサーの受信が止まっている（STALE_MS より古い）
 * - 未受信: どのセンサーにも、まだ受信が無い
 * - 正常: それ以外
 *
 * 無効にしたセンサー（enabled が false）は、札に入れない。
 *
 * 【誰が使うか】components/OverviewPage.tsx。
 */
import { classifySeverity } from "./severity";
import type { Alarm, Reading, Sensor } from "../types";

export type StripState = "critical" | "warning" | "normal" | "never";

// 最後の受信がこれより古いと「受信なし（止まっている）」とみなす。機器の多くは 1 分ごとに送るため、15 分あれば取りこぼしと見分けられる
export const STALE_MS = 15 * 60_000;

/** 札の中の 1 センサー分 */
export interface StripSensor {
  sensor: Sensor;
  latest: Reading | null;
  level: "critical" | "warning" | "normal";
}

/** 1 枚の札（機器 1 台、または機器に属さないセンサー 1 つ） */
export interface Strip {
  key: string;
  title: string;
  // 機器の系統（ライン）。無ければ null
  line: string | null;
  sensors: StripSensor[];
  state: StripState;
  // 状態の理由（例: 「洋室 CO2 重故障 上限超え」「受信なし」）。正常なら null
  reason: string | null;
  // いちばん新しい受信の時刻（ミリ秒）。まだ無ければ null
  lastTime: number | null;
}

const STATE_ORDER: Record<StripState, number> = { critical: 0, warning: 1, normal: 2, never: 3 };

/** 未解決のアラーム（発生中・確認済み）を、センサーごとに一番重いものにまとめる */
function worstAlarmBySensor(alarms: ReadonlyArray<Alarm>): Map<string, Alarm> {
  const worst = new Map<string, Alarm>();
  for (const alarm of alarms) {
    if (alarm.status === "resolved") continue;
    const current = worst.get(alarm.sensorId);
    if (!current || (current.severity === "warning" && alarm.severity === "critical")) worst.set(alarm.sensorId, alarm);
  }
  return worst;
}

/** 札を作って、状態の重い順（同じ状態なら名前順）に並べる */
export function buildStrips(
  sensors: ReadonlyArray<Sensor>,
  latest: ReadonlyArray<Reading>,
  alarms: ReadonlyArray<Alarm>,
  now: number,
): Strip[] {
  const latestBySensor = new Map(latest.map((reading) => [reading.sensorId, reading]));
  const alarmBySensor = worstAlarmBySensor(alarms);
  const groups = new Map<string, { title: string; line: string | null; sensors: Sensor[] }>();
  for (const sensor of sensors) {
    if (!sensor.enabled) continue;
    const key = sensor.deviceId ? `device:${sensor.deviceId}` : `sensor:${sensor.id}`;
    const group = groups.get(key) ?? { title: sensor.deviceName ?? sensor.name, line: sensor.deviceLine ?? null, sensors: [] };
    group.sensors.push(sensor);
    groups.set(key, group);
  }

  const strips = [...groups.entries()].map(([key, group]): Strip => {
    const items = group.sensors.map((sensor): StripSensor => {
      const reading = latestBySensor.get(sensor.id) ?? null;
      return { sensor, latest: reading, level: reading ? classifySeverity(reading.value, sensor) : "normal" };
    });
    const times = items.flatMap((item) => (item.latest ? [new Date(item.latest.recordedAt).getTime()] : []));
    const lastTime = times.length > 0 ? Math.max(...times) : null;
    const { state, reason } = judgeStrip(items, alarmBySensor, lastTime, now);
    return { key, title: group.title, line: group.line, sensors: items, state, reason, lastTime };
  });

  return strips.sort((a, b) => STATE_ORDER[a.state] - STATE_ORDER[b.state] || a.title.localeCompare(b.title, "ja"));
}

/** 札の状態と理由を決める（上の説明の優先順位） */
function judgeStrip(
  items: ReadonlyArray<StripSensor>,
  alarmBySensor: Map<string, Alarm>,
  lastTime: number | null,
  now: number,
): { state: StripState; reason: string | null } {
  if (lastTime === null) return { state: "never", reason: "まだ受信がありません" };
  const withAlarm = (severity: Alarm["severity"]) =>
    items.find((item) => alarmBySensor.get(item.sensor.id)?.severity === severity || item.level === severity);
  const critical = withAlarm("critical");
  if (critical) return { state: "critical", reason: `${critical.sensor.name} 重故障` };
  const warning = withAlarm("warning");
  if (warning) return { state: "warning", reason: `${warning.sensor.name} 軽故障` };
  // 機器の中の 1 センサーだけ止まっても気づけるよう、センサーごとに見る（まだ一度も受信の無いセンサーは除く）
  const stopped = items.find((item) => item.latest && now - new Date(item.latest.recordedAt).getTime() > STALE_MS);
  if (stopped) return { state: "warning", reason: items.length > 1 ? `${stopped.sensor.name} 受信なし` : "受信なし" };
  return { state: "normal", reason: null };
}

/** 札の数を、状態ごとに数える（見出しの「警報 1・注意 2」用） */
export function countStates(strips: ReadonlyArray<Strip>): Record<StripState, number> {
  const counts: Record<StripState, number> = { critical: 0, warning: 0, normal: 0, never: 0 };
  for (const strip of strips) counts[strip.state] += 1;
  return counts;
}

/** 経過時間の短い文字（例: 12 秒前、5 分前、3 時間前、2 日前） */
export function formatAge(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds} 秒前`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} 分前`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `${hours} 時間前`;
  return `${Math.round(hours / 24)} 日前`;
}
