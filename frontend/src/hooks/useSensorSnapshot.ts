/**
 * センサー1つ分の「いまの様子」（状態の点・現在値・推移線の元データ）を取得するフック。
 * センサー棚の行と、設定パネルのセンサー選択（SensorPicker）が同じ見た目・同じ取得を使う。
 *
 * 【誰が使うか】EditorShelf（棚の行）、SensorPicker（設定パネルの選択画面）。見た目の小さな推移線は Sparkline。
 */
import { useQuery } from "@tanstack/react-query";

import { fetchSensorReadings, fetchSensorReadingsAggregate } from "../lib/api";
import { classifySeverity } from "../lib/severity";
import { guessSensorKind, type SensorKind } from "../lib/sensor-kind";
import type { Sensor } from "../types";

/** 今日の 0 時（ローカル）を、ISO 文字列で返す（本日の累計の起点） */
function startOfToday(): string {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d.toISOString();
}

// 推移線に使う点の数と、取る期間（時間）
const SPARK_POINTS = 36;
const SPARK_HOURS = 6;
// 値を取り直す間隔（ミリ秒）。棚・選択画面は参考表示なので、ウィジェットの 5 秒より長くする
const SNAPSHOT_REFRESH_MS = 30_000;
// 開き直したときに、すぐ取り直さずキャッシュを使う時間（ミリ秒）
const SNAPSHOT_STALE_MS = 15_000;

export interface SensorSnapshot {
  kind: SensorKind;
  /** 画面に出す値（生産数は本日の累計、稼働は「稼働中／停止中」、それ以外は最新の測定値）。取得前は "—" */
  shown: string;
  /** 状態の点の色（Tailwind のクラス） */
  dotClass: string;
  /** 古い順の測定値（推移線用） */
  series: number[];
}

/** enabled が false のあいだは取得しない（画面に見えていない行で、通信を増やさないため） */
export function useSensorSnapshot(sensor: Sensor, enabled: boolean): SensorSnapshot {
  const kind = guessSensorKind(sensor);
  const { data } = useQuery({
    queryKey: ["sensor-snapshot-readings", sensor.id],
    queryFn: () => {
      const from = new Date(Date.now() - SPARK_HOURS * 60 * 60 * 1000).toISOString();
      return fetchSensorReadings(sensor.id, from, SPARK_POINTS);
    },
    enabled,
    staleTime: SNAPSHOT_STALE_MS,
    refetchInterval: enabled ? SNAPSHOT_REFRESH_MS : false,
  });
  // 生産数は「いまの値」より本日の累計のほうが意味があるため、累計を出す
  const { data: today } = useQuery({
    queryKey: ["sensor-snapshot-today", sensor.id],
    queryFn: () => fetchSensorReadingsAggregate(sensor.id, startOfToday()),
    enabled: enabled && kind === "count",
    staleTime: SNAPSHOT_STALE_MS,
    refetchInterval: enabled ? SNAPSHOT_REFRESH_MS : false,
  });

  const newestFirst = data?.readings ?? [];
  const latest = newestFirst[0]?.value;
  const series = [...newestFirst].reverse().map((r) => r.value);

  const shown =
    kind === "count"
      ? today
        ? Math.round(today.sum).toLocaleString("ja-JP")
        : "—"
      : kind === "state"
        ? latest === undefined
          ? "—"
          : latest > 0
            ? "稼働中"
            : "停止中"
        : latest === undefined
          ? "—"
          : latest.toLocaleString("ja-JP", { maximumFractionDigits: 2 });

  // 状態の点: しきい値を超えていれば橙・赤、稼働は動いていれば緑、受信が無ければ灰色
  const dotClass =
    latest === undefined
      ? "bg-gray-400"
      : kind === "state"
        ? latest > 0
          ? "bg-green-600"
          : "bg-red-600"
        : { normal: "bg-green-600", warning: "bg-amber-500", critical: "bg-red-600" }[classifySeverity(latest, sensor)];

  return { kind, shown, dotClass, series };
}
