/**
 * 書き戻しの表（試算と結果で共通）。種類ごとの、引き継ぎの行数・足される（足した）行数・本番に既にある行数。
 * 【誰が使うか】FailbackCard.tsx、R2RestoreCard.tsx。
 */
import type { FailbackResult } from "../../lib/adminApi";
import { TABLE_LABELS } from "./failbackShared";

// 書き戻しの表（試算と結果で共通）
export function FailbackResultTable({ result }: { result: FailbackResult }) {
  return (
    <table className="mt-2 w-full text-left text-sm" data-testid="failback-tables">
      <thead>
        <tr className="text-xs text-gray-500">
          <th className="py-1 pr-2 font-normal">データ</th>
          <th className="py-1 pr-2 text-right font-normal">引き継ぎの行数</th>
          <th className="py-1 pr-2 text-right font-normal">
            {result.applied ? "足した行数" : "足される行数"}
          </th>
          <th className="py-1 text-right font-normal">本番に既にある</th>
        </tr>
      </thead>
      <tbody>
        {result.tables.map((t) => (
          <tr key={t.table} className="border-t border-gray-100">
            <td className="py-1 pr-2">
              {TABLE_LABELS[t.table] ?? t.table}
              {t.note && <span className="ml-2 text-xs text-amber-700">{t.note}</span>}
            </td>
            <td className="py-1 pr-2 text-right">{t.source.toLocaleString()}</td>
            <td className="py-1 pr-2 text-right font-bold">{t.inserted.toLocaleString()}</td>
            <td className="py-1 text-right text-gray-500">{t.existing.toLocaleString()}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

