/**
 * グラフ系ウィジェットの「⋮ メニュー」と「データの表」をまとめた部品。
 * 表・CSV のためのデータ取得（センサー一覧・間引き API）は、この部品の中だけで行う。
 * グラフ系でないウィジェット（ゲージなど）には、この部品を置かない（余計な取得をしないため）。
 *
 * - メニューを開いたとき、表示範囲を記録して取り直す。直前 10 秒以内に開いていて範囲が同じなら、前の取得を使い回す
 * - 「CSV を保存」「この期間のリンクをコピー」の動きをここで決める
 * - 表は、カードの中身の下（枠の流れの中）に出す。メニューのボタンは、カードの右上に重ねる
 *
 * 【誰が使うか】WidgetCard（グラフ系のときだけ）。
 * 【引数（props）】widget・dashboard = 対象とその持ち主、editing = 編集中か（ボタンの位置を、編集用の操作の左にずらす）、
 *   tableShown・onTableShownChange = 表を開いているか、onFullscreen = 「全画面で見る」。
 */
import { useState } from "react";

import { useSensors } from "../hooks/queries";
import { useWidgetSeries, type WidgetSnapshot } from "../hooks/useWidgetSeries";
import { buildCsv, csvFileName, downloadCsv } from "../lib/csv";
import { effectiveRange } from "../lib/graph-config";
import { buildGraphLinkUrl, graphName, isGraphWidget } from "../lib/graph-link";
import { resolveRange } from "../lib/timeRange";
import { buildCsvRows, linkMinutes, linkNote, periodLabel } from "../lib/widget-table";
import { useTimeRangeStore } from "../store/useTimeRangeStore";
import type { DashboardDetail, Widget } from "../types";
import { WidgetMenu } from "./WidgetMenu";
import { WidgetTable } from "./WidgetTable";

/** この時間（ミリ秒）以内に開き直したときは、取得を使い回す */
export const REUSE_WITHIN_MS = 10_000;

export interface WidgetToolsProps {
  widget: Widget;
  dashboard: DashboardDetail;
  editing: boolean;
  tableShown: boolean;
  onTableShownChange: (shown: boolean) => void;
  onFullscreen: () => void;
}

export function WidgetTools({ widget, dashboard, editing, tableShown, onTableShownChange, onFullscreen }: WidgetToolsProps) {
  const dashboardRange = useTimeRangeStore((s) => s.range);
  const { data: sensors } = useSensors();
  const [snapshot, setSnapshot] = useState<WidgetSnapshot | null>(null);
  const exportData = useWidgetSeries(widget, snapshot);

  /** 今の表示範囲を記録する（取得のきっかけ）。直前の記録が新しく、範囲の指定も同じなら、そのまま使う */
  const refreshSnapshot = () => {
    const range = effectiveRange(widget, dashboardRange);
    const now = Date.now();
    if (snapshot && now - snapshot.nonce < REUSE_WITHIN_MS && JSON.stringify(snapshot.range) === JSON.stringify(range)) return;
    setSnapshot({ range, bounds: resolveRange(range, now), nonce: now });
  };
  const saveCsv = () => {
    if (!snapshot) return;
    downloadCsv(
      csvFileName(graphName(widget, sensors), periodLabel(snapshot.range, snapshot.bounds)),
      buildCsv(buildCsvRows(exportData.series, exportData.rows)),
    );
  };
  // リンクは、グラフ 2 種類だけ開ける（計器グラフは、リンクの画面が未対応のため項目を出さない）
  const copyLink = async (): Promise<boolean> => {
    if (!snapshot) return false;
    try {
      const base = `${window.location.origin}${window.location.pathname}`;
      await navigator.clipboard.writeText(buildGraphLinkUrl(base, dashboard.id, widget.id, linkMinutes(snapshot.range, snapshot.bounds)));
      return true;
    } catch {
      return false;
    }
  };

  return (
    <>
      {tableShown && (
        <WidgetTable
          series={exportData.series}
          rows={exportData.rows}
          loading={exportData.isLoading || snapshot === null}
          error={exportData.isError}
          onRetry={exportData.refetch}
          onClose={() => onTableShownChange(false)}
        />
      )}
      {/* 編集中は、右上に編集用の操作（つかむ目印・設定・複製・削除）が重なるので、その左に置く */}
      <div className={`absolute top-1 z-10 rounded-md bg-white/80 ${editing ? "right-[7.25rem]" : "right-1"}`}>
        <WidgetMenu
          onOpen={refreshSnapshot}
          onFullscreen={onFullscreen}
          onToggleTable={() => {
            if (!tableShown) refreshSnapshot();
            onTableShownChange(!tableShown);
          }}
          tableShown={tableShown}
          csv={exportData.isError ? "error" : exportData.ready ? "ready" : "loading"}
          onSaveCsv={saveCsv}
          onCopyLink={isGraphWidget(widget) ? copyLink : null}
          linkNote={snapshot ? linkNote(snapshot.range, snapshot.bounds) : undefined}
        />
      </div>
    </>
  );
}
