/**
 * 「グラフを 1 画面で開くリンク」の URL の読み書き。
 *
 * リンクの形: /?dashboard=<ダッシュボードの ID>&graph=<ウィジェットの ID>&range=<N>m（N は 10〜10080 分）
 * 例: https://<アドレス>/?dashboard=3f8c…&graph=9d41…&range=30m → そのグラフ 1 つを「直近 30 分」で開く
 *
 * 画面（React）に依存しない関数だけを置く（テストしやすくするため）。
 *
 * 【誰が使うか】useUiStore（開いたときの URL を読む）、App.tsx・GraphLinkView（見つからないときに URL を消す）、
 * GraphLinkDialog（リンクを作る）、LoginPage（ログイン前の案内）。
 */
import { graphSensorIds } from "./graph-config";
import { widgetLabel } from "./widget-catalog";
import type { Sensor, Widget } from "../types";

/** リンクで開くグラフ。rangeMinutes は「直近 ◯ 分」 */
export interface GraphLink {
  dashboardId: string;
  graphId: string;
  rangeMinutes: number;
}

/** URL を読んだ結果。none = リンクではない、broken = ID が片方しか無い・形がおかしい、link = 開けるリンク */
export type GraphLinkParse = { kind: "none" } | { kind: "broken" } | { kind: "link"; link: GraphLink };

/** リンクの「直近」の下限・上限（分）と、range がおかしいときの既定 */
export const LINK_MIN_MINUTES = 10;
export const LINK_MAX_MINUTES = 10080; // 7 日
export const LINK_DEFAULT_MINUTES = 30;

// ダッシュボード・ウィジェットの ID の形（UUID）。URL から入る値なので、API のパスに入れる前に形を確かめる
// （`../sensors` のような値で、別の API に届かないように）
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// リンクが使う URL のクエリの名前（range は、ダッシュボードの期間の ?range=1h と同じ名前）
const LINK_KEYS = ["dashboard", "graph", "range"] as const;

/** range=<N>m を分に直す。形が違う・範囲の外なら null */
export function parseLinkMinutes(text: string | null): number | null {
  const match = /^(\d+)m$/.exec(text ?? "");
  if (!match) return null;
  const minutes = Number(match[1]);
  return minutes >= LINK_MIN_MINUTES && minutes <= LINK_MAX_MINUTES ? minutes : null;
}

/** URL のクエリ（location.search）から、リンクを読む。range がおかしいときは既定の 30 分にする */
export function parseGraphLink(search: string): GraphLinkParse {
  const params = new URLSearchParams(search);
  const dashboardId = params.get("dashboard")?.trim() ?? "";
  const graphId = params.get("graph")?.trim() ?? "";
  if (!dashboardId && !graphId) return { kind: "none" };
  if (!UUID_PATTERN.test(dashboardId) || !UUID_PATTERN.test(graphId)) return { kind: "broken" };
  const rangeMinutes = parseLinkMinutes(params.get("range")) ?? LINK_DEFAULT_MINUTES;
  return { kind: "link", link: { dashboardId, graphId, rangeMinutes } };
}

/** 今のページの URL から、リンクを読む（URL を読めない環境では「リンクではない」） */
export function readGraphLinkFromUrl(): GraphLinkParse {
  try {
    return parseGraphLink(window.location.search);
  } catch {
    return { kind: "none" };
  }
}

/** リンクの URL を作る。base は「https://<アドレス>/」の形（ページの origin + パス） */
export function buildGraphLinkUrl(base: string, dashboardId: string, graphId: string, minutes: number): string {
  const params = new URLSearchParams({ dashboard: dashboardId, graph: graphId, range: `${minutes}m` });
  return `${base}?${params.toString()}`;
}

/** URL から、リンクのクエリだけを消す（見つからないとき。履歴は増やさない） */
export function clearGraphLinkFromUrl() {
  try {
    const url = new URL(window.location.href);
    LINK_KEYS.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(null, "", url.toString());
  } catch {
    // URL を書き換えられない環境（プレビューなど）では、画面の切り替えだけを行う
  }
}

/** リンクで開けるウィジェットか（グラフの 2 種類だけ） */
export function isGraphWidget(widget: Pick<Widget, "type">): boolean {
  return widget.type === "SensorGraph" || widget.type === "MultiSensorComparison";
}

/** グラフの名前。付けたタイトル → センサーの名前（「・」でつなぐ）→ 種類の名前、の順 */
export function graphName(widget: Pick<Widget, "type" | "sensorId" | "config">, sensors: Sensor[] | undefined): string {
  const title = widget.config.title?.trim();
  if (title) return title;
  const names = graphSensorIds(widget).flatMap((id) => {
    const name = widget.config.seriesNames?.[id]?.trim() || sensors?.find((s) => s.id === id)?.name;
    return name ? [name] : [];
  });
  return names.length > 0 ? names.join("・") : widgetLabel(widget.type);
}
