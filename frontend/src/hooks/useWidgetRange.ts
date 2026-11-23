/**
 * ウィジェットが使う表示期間を返すフック。ふだんはダッシュボードの期間（useTimeRangeStore。ウィジェット個別の期間があればそれ）。
 * ダッシュボード全体のリンクの一覧（DashboardLinkView）の中では、LinkRangeContext で渡された共通の期間に差し替える。
 * Context が無いとき（ふつうのダッシュボード）は、今までと同じ動きで、何も変わらない。
 *
 * 一覧の期間は、指を離して少したってから決まる取得の範囲（LinkGraphView.fetchBounds）を渡す
 * （指を動かすたびに、これらのウィジェットが取り直さないため）。
 *
 * 【誰が使うか】TrendStackWidget、StateTimelineWidget、TargetStripWidget（期間で動くウィジェット）。LinkRangeContext は DashboardLinkView が与える。
 */
import { createContext, useContext } from "react";

import { effectiveRange } from "../lib/graph-config";
import type { TimeRange } from "../lib/timeRange";
import { useTimeRangeStore } from "../store/useTimeRangeStore";
import type { Widget } from "../types";

/** リンクの一覧で、全ウィジェットに共通の期間（ミリ秒）。null はふつうのダッシュボード */
export const LinkRangeContext = createContext<{ from: number; to: number } | null>(null);

/** このウィジェットが使う表示期間。一覧の中では共通の期間（固定）、それ以外は今までどおり */
export function useWidgetRange(widget: Pick<Widget, "config">): TimeRange {
  const linkRange = useContext(LinkRangeContext);
  const dashboardRange = useTimeRangeStore((s) => s.range);
  if (linkRange) return { mode: "absolute", from: linkRange.from, to: linkRange.to };
  return effectiveRange(widget, dashboardRange);
}
