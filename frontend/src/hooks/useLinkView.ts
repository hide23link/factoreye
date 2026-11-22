/**
 * リンクの画面（LinkScreen・DashboardLinkView）で共通に使う、取得・期間・知らせのフック。
 *
 * - useLinkRows: グラフと同じ取得（同じ queryKey）で、時刻ごとの行を作る（今の値・タップした時刻の値用）。
 * - useSettledPeriod: 指を離して SETTLE_MS たってから、取得の期間を表示に合わせる。
 * - useToast: 短い知らせ。
 *
 * 【誰が使うか】components/link/LinkScreen.tsx、components/link/DashboardLinkView.tsx。
 */
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { fetchSensorReadingsDownsampled } from "../lib/api";
import { graphDataOptions, graphSensorIds } from "../lib/graph-config";
import { buildRows } from "../lib/graph-series";
import type { LinkPeriod } from "../lib/link-range";
import { resolveRefetchMs } from "../lib/refresh-interval";
import { useRefreshStore } from "../store/useRefreshStore";
import type { Widget } from "../types";
import { GRAPH_BUCKETS } from "../components/widgets/graph-parts";

/** 短い知らせ（「リンクの設定に戻しました」など）を出す時間（ミリ秒） */
const TOAST_MS = 900;
/** 指を離してから、取得の期間を表示に合わせるまでの時間（ミリ秒）。ホイール・続けて押したボタンもまとめて 1 回にする */
export const SETTLE_MS = 300;

/**
 * グラフと同じ取得（同じ queryKey なので、通信はグラフと共有される）で、時刻ごとの行を作る。今の値・タップした時刻の値に使う。
 * updatedAt は、最後に取れた時刻（状態の行の「11:30 更新」）。
 */
export function useLinkRows(widget: Widget, bounds: { from: number; to: number }, live: boolean) {
  const sensorIds = graphSensorIds(widget);
  const options = graphDataOptions(widget.config, sensorIds.length);
  // 画面の更新間隔の選択（各グラフの設定に従う以外なら、間隔を上書きする）
  const refreshChoice = useRefreshStore((s) => s.choice);
  const results = useQueries({
    queries: sensorIds.map((sensorId) => ({
      queryKey: ["readings-downsampled", sensorId, Math.round(bounds.from / 1000), Math.round(bounds.to / 1000), GRAPH_BUCKETS],
      queryFn: () =>
        fetchSensorReadingsDownsampled(sensorId, new Date(bounds.from).toISOString(), new Date(bounds.to).toISOString(), GRAPH_BUCKETS),
      refetchInterval: live ? resolveRefetchMs(refreshChoice, options.refreshMs) : false,
      placeholderData: keepPreviousData,
    })),
  });
  const inputs = sensorIds.flatMap((sensorId, i) => {
    const data = results[i]?.data;
    return data ? [{ sensorId, bucketSeconds: data.bucketSeconds, buckets: data.buckets }] : [];
  });
  const updatedAt = Math.max(0, ...results.map((r) => r.dataUpdatedAt));
  return { rows: buildRows(inputs, options.aggregation), updatedAt };
}

/**
 * 取得に使う期間。指を置いている間（holding）は変えず、離してから SETTLE_MS たって、表示の期間に合わせる。
 */
export function useSettledPeriod(period: LinkPeriod, holding: boolean): LinkPeriod {
  const [settled, setSettled] = useState(period);
  useEffect(() => {
    if (holding) return;
    const timer = setTimeout(() => setSettled(period), SETTLE_MS);
    return () => clearTimeout(timer);
  }, [period, holding]);
  return settled;
}

/** 短い知らせ。flash で出し、少しして消す */
export function useToast() {
  const [message, setMessage] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout>>();
  useEffect(() => () => clearTimeout(timer.current), []);
  const flash = (text: string) => {
    setMessage(text);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setMessage(null), TOAST_MS);
  };
  return { message, flash };
}
