/**
 * グラフ系ウィジェットの「表」と「CSV」のためのデータ取得。
 * メニューを開いた時点の表示範囲（snapshot）で、グラフと同じ取得（間引き API・区間数 GRAPH_BUCKETS）を取り直す。
 * 新しい API は使わない。メニューを開くたびに nonce が変わるので、必ず取り直す（古い値の CSV を作らないため）。
 *
 * 【誰が使うか】WidgetCard（表の表示・CSV の保存に渡す）。
 * 【引数】widget = 対象のウィジェット、snapshot = 取得する範囲（null の間は取得しない）。
 * 【戻り値】series = 線ごとの結果、rows = 表の行（古い順）、aggregation = 値の選び方、isLoading・isError・refetch。
 */
import { useQueries } from "@tanstack/react-query";
import { useMemo } from "react";

import { fetchSensorReadingsDownsampled } from "../lib/api";
import { graphDataOptions, graphSensorIds } from "../lib/graph-config";
import { buildTableRows, type TableRow, type TableSeries } from "../lib/widget-table";
import type { ResolvedRange, TimeRange } from "../lib/timeRange";
import type { Widget } from "../types";
import { GRAPH_BUCKETS } from "../components/widgets/graph-parts";
import { useSensors } from "./queries";

/** メニューを開いた時点の範囲。range = 表示の指定（ファイル名・リンクに使う）、bounds = 実際の開始と終了、nonce = 開いた回を区別する値 */
export interface WidgetSnapshot {
  range: TimeRange;
  bounds: ResolvedRange;
  nonce: number;
}

export function useWidgetSeries(widget: Widget, snapshot: WidgetSnapshot | null) {
  const { data: sensors } = useSensors();
  const ids = graphSensorIds(widget);
  const aggregation = graphDataOptions(widget.config, ids.length).aggregation;
  const results = useQueries({
    queries: ids.map((id) => ({
      queryKey: ["widget-export", id, snapshot?.nonce ?? 0, snapshot?.bounds.from, snapshot?.bounds.to, GRAPH_BUCKETS],
      queryFn: () =>
        fetchSensorReadingsDownsampled(
          id,
          new Date((snapshot as WidgetSnapshot).bounds.from).toISOString(),
          new Date((snapshot as WidgetSnapshot).bounds.to).toISOString(),
          GRAPH_BUCKETS,
        ),
      enabled: snapshot !== null,
      staleTime: 0,
      gcTime: 60_000,
      retry: 1,
    })),
  });

  const isLoading = snapshot !== null && results.some((r) => r.isPending);
  const isError = results.some((r) => r.isError);
  const ready = snapshot !== null && !isLoading && !isError;
  // 取得の結果が変わったときだけ作り直す（描画のたびに行を作り直さない）
  const dataKey = results.map((r) => r.dataUpdatedAt).join(",");
  const { series, rows } = useMemo<{ series: TableSeries[]; rows: TableRow[] }>(() => {
    if (!ready) return { series: [], rows: [] };
    const made = ids.map((id, i) => {
      const sensor = sensors?.find((s) => s.id === id);
      return {
        name: widget.config.seriesNames?.[id]?.trim() || sensor?.name || id,
        unit: sensor?.unit ?? "",
        buckets: results[i].data?.buckets ?? [],
      };
    });
    return { series: made, rows: buildTableRows(made, aggregation) };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- results は毎回新しい配列。結果の更新時刻（dataKey）で代わりに見る
  }, [ready, dataKey, ids.join(","), sensors, aggregation, widget.config.seriesNames]);

  return {
    ready,
    isLoading,
    isError,
    series,
    rows,
    refetch: () => results.forEach((r) => void r.refetch()),
  };
}
