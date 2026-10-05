/**
 * 画面のデータを取得するフック（React Query）。
 *
 * - データはキャッシュされ、同じ queryKey の画面どうしで共有される
 * - 変化が速いデータ（センサー値、アラーム、ダッシュボードの中身）は、POLL_INTERVAL_MS（5 秒）ごとに取り直す
 * - 変化の少ないデータ（通知設定、移行の状態など）は、取り直さない
 */
import { useQuery } from "@tanstack/react-query";

import {
  fetchAlarms,
  fetchDashboard,
  fetchDashboards,
  fetchMigrationStatus,
  fetchNotificationSettings,
  fetchSensorReadings,
  fetchSensorReadingsAggregate,
  fetchSensorReadingsDownsampled,
  fetchSensors,
  fetchWebhookSubscriptions,
} from "../lib/api";

// 画面を更新する間隔（ミリ秒）。ポーリング（一定間隔で取り直す）の周期
const POLL_INTERVAL_MS = 5000;

/** センサーの一覧（5 秒ごとに取り直す）。 */
export const useSensors = () =>
  useQuery({ queryKey: ["sensors"], queryFn: fetchSensors, refetchInterval: POLL_INTERVAL_MS });

/** ダッシュボードの一覧。 */
export const useDashboards = () =>
  useQuery({ queryKey: ["dashboards"], queryFn: fetchDashboards });

/** 1つのダッシュボードの詳細（5 秒ごとに取り直す）。id が無いときは取りに行かない。 */
export const useDashboard = (id: string | null) =>
  useQuery({
    queryKey: ["dashboard", id],
    queryFn: () => fetchDashboard(id as string),
    enabled: id !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });

/** アラームの一覧（5 秒ごとに取り直す）。status で絞り込める。 */
export const useAlarms = (status?: string) =>
  useQuery({
    queryKey: ["alarms", status ?? "all"],
    queryFn: () => fetchAlarms(status),
    refetchInterval: POLL_INTERVAL_MS,
  });

/** 通知設定。 */
export const useNotificationSettings = () =>
  useQuery({ queryKey: ["notification-settings"], queryFn: fetchNotificationSettings });

/** Webhook の購読の一覧。 */
export const useWebhookSubscriptions = () =>
  useQuery({ queryKey: ["webhook-subscriptions"], queryFn: fetchWebhookSubscriptions });

/**
 * 移行機能の状態。画面を開いている間は変わらないので、一度取れば取り直さない（staleTime: Infinity）。
 */
export const useMigrationStatus = () =>
  useQuery({ queryKey: ["migration-status"], queryFn: fetchMigrationStatus, staleTime: Infinity });

/**
 * 1センサーの測定値の履歴（既定は直近 1 時間）。sensorId が無いときは取りに行かない。
 */
export const useSensorReadings = (sensorId: string | null, hours = 1) =>
  useQuery({
    queryKey: ["readings", sensorId, hours],
    queryFn: () => {
      const from = new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
      return fetchSensorReadings(sensorId as string, from);
    },
    enabled: sensorId !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });

// from/to は呼び出し側（ウィジェット）が計算して渡す（例: 「直近1時間」「本日0時から」）。
// pollごとに境界がわずかにズレてもキャッシュが無駄に増えないよう、分単位に丸めたISO文字列を
// queryKeyにそのまま使う想定
export const useSensorReadingsAggregate = (
  sensorId: string | null,
  from: string,
  to?: string,
) =>
  useQuery({
    queryKey: ["readings-aggregate", sensorId, from, to ?? null],
    queryFn: () => fetchSensorReadingsAggregate(sensorId as string, from, to),
    enabled: sensorId !== null,
    refetchInterval: POLL_INTERVAL_MS,
  });

/**
 * グラフ用の間引きデータ。from / to は、ミリ秒の時刻（呼び出し側が範囲から求める）。
 * live（直近モード）のときだけ、POLL_INTERVAL_MS ごとに取り直す。固定モードは取り直さない。
 *
 * queryKey は秒単位に丸める。時刻が 1 秒ごとに少しずつ進んでも、同じ範囲の取得を重ねないため。
 */
export const useDownsampledReadings = (
  sensorId: string | null,
  range: { from: number; to: number },
  buckets: number,
  live: boolean,
) =>
  useQuery({
    queryKey: [
      "readings-downsampled",
      sensorId,
      Math.round(range.from / 1000),
      Math.round(range.to / 1000),
      buckets,
    ],
    queryFn: () =>
      fetchSensorReadingsDownsampled(
        sensorId as string,
        new Date(range.from).toISOString(),
        new Date(range.to).toISOString(),
        buckets,
      ),
    enabled: sensorId !== null,
    refetchInterval: live ? POLL_INTERVAL_MS : false,
  });
