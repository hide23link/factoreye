/**
 * グラフの下に開く「データの表」。新しい順に、先頭 12 行を出し、「もっと見る」で 12 行ずつ増やす。
 * 表の元は CSV と同じ取得データ（useWidgetSeries）。
 *
 * 【誰が使うか】WidgetCard が、メニューの「データを表で見る」を選んだときにグラフの下へ出す。
 * 【引数（props）】series = 線（センサー）ごとの名前・単位（列の見出し）、rows = 行（古い順）、
 *   loading = 取得中か、error = 取得に失敗したか、onRetry = 失敗したときの「再取得」、onClose = 表を閉じる。
 */
import { useState } from "react";

import { columnTitle, formatTableTime, formatTableValue, type TableRow, type TableSeries } from "../lib/widget-table";

/** 1 回に出す行数（先頭と、「もっと見る」ごとの増分） */
export const TABLE_PAGE_SIZE = 12;

export interface WidgetTableProps {
  series: ReadonlyArray<TableSeries>;
  rows: ReadonlyArray<TableRow>;
  loading: boolean;
  error: boolean;
  onRetry: () => void;
  onClose: () => void;
}

export function WidgetTable({ series, rows, loading, error, onRetry, onClose }: WidgetTableProps) {
  const [shown, setShown] = useState(TABLE_PAGE_SIZE);
  // 新しい順（rows は古い順）
  const newestFirst = [...rows].reverse().slice(0, shown);

  return (
    // 表の中の操作は、カードの移動（ドラッグ）に使わない
    <div className="widget-no-drag mt-1 flex max-h-[45%] min-h-[4rem] shrink-0 flex-col rounded border border-gray-200 bg-white text-xs">
      <div className="flex items-center gap-2 border-b border-gray-200 px-2 py-1">
        <span className="font-semibold">データ（新しい順）</span>
        {!loading && !error && <span className="text-gray-500">{rows.length} 行</span>}
        <button type="button" aria-label="表を閉じる" onClick={onClose} className="ml-auto rounded px-1.5 text-gray-500 hover:bg-gray-100 hover:text-gray-900">
          ✕
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {error ? (
          <p className="p-2 text-red-600">
            取得に失敗しました。{" "}
            <button type="button" onClick={onRetry} className="underline">
              再取得
            </button>
          </p>
        ) : loading ? (
          <p className="p-2 text-gray-500">読み込み中...</p>
        ) : rows.length === 0 ? (
          <p className="p-2 text-gray-500">この期間のデータはありません</p>
        ) : (
          <table className="w-full border-collapse font-num">
            <thead className="sticky top-0 bg-white text-left text-gray-500">
              <tr>
                <th scope="col" className="whitespace-nowrap px-2 py-0.5 font-normal">時刻 (JST)</th>
                {series.map((one, i) => (
                  <th key={i} scope="col" className="whitespace-nowrap px-2 py-0.5 text-right font-normal">
                    {columnTitle(one)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {newestFirst.map((row) => (
                <tr key={row.timeMs} className="border-t border-gray-100">
                  <td className="whitespace-nowrap px-2 py-0.5">{formatTableTime(row.timeMs)}</td>
                  {row.values.map((value, i) => (
                    <td key={i} className="px-2 py-0.5 text-right">
                      {formatTableValue(value)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>
      {!error && !loading && rows.length > shown && (
        <button type="button" onClick={() => setShown((n) => n + TABLE_PAGE_SIZE)} className="border-t border-gray-200 py-1 text-blue-700 hover:bg-blue-50">
          もっと見る（残り {rows.length - shown} 行）
        </button>
      )}
    </div>
  );
}
