/**
 * リンク（/?dashboard=…&graph=…&range=…m）で開いたときの画面。そのグラフ 1 つを、画面いっぱいに出す。
 * ヘッダー・メニュー・下のメニューは出さない。画面は縦スクロールしない（横向きでも 1 画面）。
 * graph の無いリンク（/?dashboard=…&range=…m）は、ダッシュボード全体の一覧（DashboardLinkView。縦にスクロールする）を出す。
 *
 * ダッシュボードかグラフが見つからない（消された・別のワークスペース・グラフではないウィジェット）ときは、
 * URL のリンクの部分を消して一覧を開き、一覧に黄色の帯を出す（useUiStore の showLinkNotFound）。
 *
 * 【誰が使うか】App.tsx が、useUiStore の graphLink があるときに出す。
 * 【引数（props）】link = URL から読んだリンク（lib/graph-link.ts の GraphLink）。
 */
import { useEffect } from "react";

import { useDashboard } from "../../hooks/queries";
import { errorStatus } from "../../lib/errors";
import { clearGraphLinkFromUrl, isDashboardLink, isGraphWidget, type GraphLink } from "../../lib/graph-link";
import { useUiStore } from "../../store/useUiStore";
import { ErrorNotice } from "../ErrorNotice";
import { DashboardLinkView } from "./DashboardLinkView";
import { LinkScreen } from "./LinkScreen";

// 「見つからない」とみなす応答（404 = 無い・別のワークスペース、403 = 見られない、422 = ID の形が違う）
const NOT_FOUND_STATUSES = [403, 404, 422];

export function GraphLinkView({ link }: { link: GraphLink }) {
  const { data: dashboard, error, isError, refetch } = useDashboard(link.dashboardId);
  const showLinkNotFound = useUiStore((s) => s.showLinkNotFound);
  const widget = dashboard?.widgets.find((w) => w.id === link.graphId);
  const dashboardMissing = !dashboard && isError && NOT_FOUND_STATUSES.includes(errorStatus(error) ?? 0);
  const whole = isDashboardLink(link);
  const graphMissing = !whole && dashboard !== undefined && (!widget || !isGraphWidget(widget));
  const missing = dashboardMissing || graphMissing;

  useEffect(() => {
    if (!missing) return;
    clearGraphLinkFromUrl();
    showLinkNotFound();
  }, [missing, showLinkNotFound]);

  if (!dashboard && isError && !missing) {
    return (
      <div className="p-4">
        <ErrorNotice message="ダッシュボードを取得できませんでした。" onRetry={() => void refetch()} />
      </div>
    );
  }
  if (whole && dashboard && !missing) {
    return <DashboardLinkView dashboard={dashboard} rangeMinutes={link.rangeMinutes} />;
  }
  if (!widget || missing) {
    return <p className="p-4 text-sm text-gray-500">読み込み中...</p>;
  }
  return (
    // 画面の大きさに固定する（ページを縦スクロールさせない。指の操作とぶつからないように）
    <div className="fixed inset-0 overscroll-none">
      <LinkScreen widget={widget} rangeMinutes={link.rangeMinutes} />
    </div>
  );
}
