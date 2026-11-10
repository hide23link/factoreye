/**
 * リンクで開いたグラフ 1 つの画面（上: グラフ名・期間・今の値、中: グラフ、下: 期間のボタン・状態の行）。
 *
 * グラフは、ダッシュボードと同じウィジェット（SensorGraphWidget・MultiSensorComparisonWidget）で描く（線・色・縦軸が同じ）。
 * 期間はこの画面の中だけで持つ（lib/link-range.ts）。ダッシュボードの期間（useTimeRangeStore）を通さないので、
 * 端末に覚えた期間・URL では上書きせず、指で変えた期間も保存しない。今を見ている間は、グラフの設定の間隔で自動更新する。
 *
 * 【誰が使うか】GraphLinkView（リンクで開いたとき。画面いっぱい）と、GraphLinkDialog（開いたときの画面の小さな見本）。
 * 【引数（props）】widget = 出すグラフのウィジェット、rangeMinutes = リンクの「直近 ◯ 分」、
 * preview = 見本のとき true（指の操作・時刻の指定・ボタンを止める）。
 */
import { keepPreviousData, useQueries } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";

import { useSensors } from "../../hooks/queries";
import { useLinkGestures } from "../../hooks/useLinkGestures";
import { useNow } from "../../hooks/useNow";
import { fetchSensorReadingsDownsampled } from "../../lib/api";
import { graphColor, graphDataOptions, graphSensorIds } from "../../lib/graph-config";
import { graphName } from "../../lib/graph-link";
import { buildRows, nearestValue } from "../../lib/graph-series";
import {
  LINK_CHIPS_MINUTES,
  chipPeriod,
  chipText,
  clockText,
  durationText,
  isAtLink,
  isChipActive,
  linkPeriod,
  periodBounds,
  periodLabel,
  startAtPeriod,
  statusText,
  type LinkPeriod,
} from "../../lib/link-range";
import { maxRangeForBuild } from "../../lib/timeRange";
import type { Widget } from "../../types";
import { GRAPH_BUCKETS, formatYTick } from "../widgets/graph-parts";
import { MultiSensorComparisonWidget } from "../widgets/MultiSensorComparisonWidget";
import { SensorGraphWidget } from "../widgets/SensorGraphWidget";
import { LinkTimeSheet } from "./LinkTimeSheet";

/** 短い知らせ（「リンクの設定に戻しました」など）を出す時間（ミリ秒） */
const TOAST_MS = 900;

/**
 * グラフと同じ取得（同じ queryKey なので、通信はグラフと共有される）で、時刻ごとの行を作る。今の値・タップした時刻の値に使う。
 * updatedAt は、最後に取れた時刻（状態の行の「11:30 更新」）。
 */
function useLinkRows(widget: Widget, bounds: { from: number; to: number }, live: boolean) {
  const sensorIds = graphSensorIds(widget);
  const options = graphDataOptions(widget.config, sensorIds.length);
  const results = useQueries({
    queries: sensorIds.map((sensorId) => ({
      queryKey: ["readings-downsampled", sensorId, Math.round(bounds.from / 1000), Math.round(bounds.to / 1000), GRAPH_BUCKETS],
      queryFn: () =>
        fetchSensorReadingsDownsampled(sensorId, new Date(bounds.from).toISOString(), new Date(bounds.to).toISOString(), GRAPH_BUCKETS),
      refetchInterval: live ? options.refreshMs : false,
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

/** 短い知らせ。flash で出し、少しして消す */
function useToast() {
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

export function LinkScreen({ widget, rangeMinutes, preview = false }: { widget: Widget; rangeMinutes: number; preview?: boolean }) {
  const { data: sensors } = useSensors();
  const sensorIds = graphSensorIds(widget);
  const options = graphDataOptions(widget.config, sensorIds.length);
  // 今を見ている間は、グラフの設定の間隔（既定 30 秒）ごとに範囲を進める（ダッシュボードのグラフと同じ）
  const now = useNow(options.refreshMs);
  const [period, setPeriod] = useState<LinkPeriod>(() => linkPeriod(rangeMinutes));
  const [cursorTime, setCursorTime] = useState<number | null>(null);
  const [sheetOpen, setSheetOpen] = useState(false);
  const toast = useToast();
  const maxMs = maxRangeForBuild();
  const live = period.endMs === null;
  const bounds = periodBounds(period, now);
  const { rows, updatedAt } = useLinkRows(widget, bounds, live);

  const backToLink = () => {
    setPeriod(linkPeriod(rangeMinutes));
    setCursorTime(null);
    toast.flash("リンクの設定に戻しました");
  };
  const gestures = useLinkGestures({
    period,
    now,
    maxMs,
    onChange: (next, zoomed) => {
      setPeriod(next);
      setCursorTime(null);
      if (zoomed) toast.flash(durationText(next.durationMs));
    },
    onTap: (ratio) => setCursorTime(bounds.from + (bounds.to - bounds.from) * ratio),
    onDoubleTap: backToLink,
  });
  const applyStart = (startMs: number) => {
    const next = startAtPeriod(period, startMs, Date.now());
    if (!next) {
      toast.flash("まだ来ていない時刻です");
      return;
    }
    setPeriod(next);
    setCursorTime(null);
    setSheetOpen(false);
    toast.flash(`${clockText(startMs)} から表示`);
  };

  const valueAt = cursorTime ?? bounds.to;
  const linkView = { bounds, live, cursorTime };
  const unitOf = (id: string) => sensors?.find((s) => s.id === id)?.unit ?? "";
  const nameOf = (id: string) => widget.config.seriesNames?.[id]?.trim() || sensors?.find((s) => s.id === id)?.name || id;

  return (
    <div className="relative flex h-full select-none flex-col bg-white text-gray-900">
      <div className="flex items-baseline justify-between gap-2 px-3 pb-0.5 pt-2.5">
        <b className="min-w-0 truncate text-sm">{graphName(widget, sensors)}</b>
        <button
          type="button"
          aria-label="時刻を指定"
          disabled={preview}
          onClick={() => setSheetOpen(true)}
          className="flex shrink-0 items-center gap-1 rounded-full border border-gray-200 px-2 text-xs tabular-nums text-gray-500"
        >
          {periodLabel(period, now)} 🕘
        </button>
      </div>
      <div className="flex min-h-6 flex-wrap gap-3 px-3 pb-1 pt-0.5 text-xs text-gray-500">
        {sensorIds.map((id, i) => {
          const value = nearestValue(rows, id, valueAt);
          return (
            <span key={id}>
              <i aria-hidden="true" className="mr-1 inline-block h-2 w-2 rounded-sm align-[1px]" style={{ background: graphColor(widget, i) }} />
              {nameOf(id)} {unitOf(id)} <b className="text-base tabular-nums text-gray-900">{value === null ? "—" : formatYTick(value)}</b>
            </span>
          );
        })}
        {cursorTime !== null && <span>{clockText(cursorTime)} の値</span>}
      </div>
      <div
        ref={preview ? undefined : gestures.ref}
        {...(preview ? {} : gestures.handlers)}
        aria-label="グラフ。上下になぞると拡大・縮小、左右になぞると時間を動かす"
        // タップでグラフ（recharts）に付く、フォーカスの枠は出さない（タップは時刻の値を出す操作のため）
        className="relative min-h-0 flex-1 cursor-grab px-1.5 active:cursor-grabbing [&_:focus]:outline-none"
        style={{ touchAction: "none" }}
      >
        {widget.type === "MultiSensorComparison" ? (
          <MultiSensorComparisonWidget widget={widget} linkView={linkView} />
        ) : (
          <SensorGraphWidget widget={widget} linkView={linkView} />
        )}
        {toast.message && (
          <div className="pointer-events-none absolute left-1/2 top-2.5 -translate-x-1/2 whitespace-nowrap rounded-full bg-gray-900 px-2.5 py-0.5 text-xs text-white">
            {toast.message}
          </div>
        )}
      </div>
      <div role="group" aria-label="期間" className="flex gap-1.5 overflow-x-auto px-2.5 py-2">
        {LINK_CHIPS_MINUTES.map((minutes) => {
          const active = isChipActive(period, minutes);
          return (
            <button
              key={minutes}
              type="button"
              disabled={preview}
              aria-pressed={active}
              onClick={() => {
                setPeriod(chipPeriod(period, minutes, now, maxMs));
                setCursorTime(null);
              }}
              className={`shrink-0 rounded-full border px-3 py-1 text-xs ${active ? "border-blue-600 bg-blue-600 font-bold text-white" : "border-gray-200 bg-white"}`}
            >
              {chipText(minutes)}
            </button>
          );
        })}
      </div>
      <div className="flex min-h-9 items-center justify-between gap-1.5 px-2.5 pb-2.5 text-xs text-gray-500">
        <span>{statusText(period, now, updatedAt || now)}</span>
        {!isAtLink(period, rangeMinutes) && !preview && (
          <button
            type="button"
            onClick={backToLink}
            className="rounded-full border border-blue-600 bg-blue-50 px-2.5 py-0.5 text-xs font-bold text-blue-600"
          >
            今に戻る
          </button>
        )}
      </div>
      {sheetOpen && <LinkTimeSheet startMs={bounds.from} now={now} onApply={applyStart} onCancel={() => setSheetOpen(false)} />}
    </div>
  );
}
