/**
 * 画面の状態（どの画面を見ているか、どのダッシュボードを選んでいるか）。
 * zustand（小さな状態管理ライブラリ）のストア。画面のどこからでも、同じ状態を読み書きできる。
 *
 * 【誰が使うか】App.tsx（メニュー）、DashboardHome、DashboardView、SetupWizard、GraphLinkView。
 */
import { create } from "zustand";

import { readGraphLinkFromUrl, type GraphLink } from "../lib/graph-link";
import { writeLastDashboardId } from "../lib/last-dashboard";
import { useRefreshStore } from "./useRefreshStore";
import { leaveDashboardInHistory } from "./useTimeRangeStore";

// 画面の種類: メイン（ダッシュボード）、全体監視、設定、セットアップガイド
export type AppView = "main" | "overview" | "settings" | "wizard";

interface UiState {
  view: AppView;
  selectedDashboardId: string | null;
  // 選んだダッシュボードを、編集モードで開くか（新しく作った直後に、そのまま編集に入るため）
  openInEditMode: boolean;
  // 画面表示モード（キオスク）。ヘッダー・メニュー・操作類を隠して、ダッシュボードだけを大きく出す（壁掛けのモニター・スマホ向け）
  kiosk: boolean;
  setKiosk: (kiosk: boolean) => void;
  // 画面表示モードを保ったまま、別のダッシュボードへ移る（自動切替・前後の移動用）
  switchDashboard: (id: string) => void;
  setView: (view: AppView) => void;
  selectDashboard: (id: string | null, options?: { edit?: boolean }) => void;
  // ダッシュボードを選んでいないときに、最後に見たもの（無ければ先頭）を自動で開く。利用者の操作ではないので、リンクの「見つからない」の帯は消さない
  autoSelectDashboard: (id: string) => void;
  // リンク（?dashboard=…&graph=…&range=…）で開いたグラフ。null でなければ、そのグラフ 1 つだけを画面いっぱいに出す
  graphLink: GraphLink | null;
  // リンクのグラフが見つからなかった（ダッシュボードの画面の上に黄色の帯を出す）。ほかの画面へ移る・ダッシュボードを選ぶと消える
  linkNotFound: boolean;
  // リンクのグラフが見つからないとき: リンクの画面をやめて、ダッシュボードの画面を開く（最後に見たものが開く）
  showLinkNotFound: () => void;
}

// ページを開いたときの URL。リンクなら、そのグラフの画面から始める（SaaS はログインの後も URL が残るので、同じ画面になる）
const initialLink = readGraphLinkFromUrl();

export const useUiStore = create<UiState>((set, get) => ({
  view: "main",
  selectedDashboardId: null,
  openInEditMode: false,
  kiosk: false,
  graphLink: initialLink.kind === "link" ? initialLink.link : null,
  linkNotFound: initialLink.kind === "broken",
  showLinkNotFound: () => set({ graphLink: null, linkNotFound: true, view: "main", selectedDashboardId: null, kiosk: false }),
  setKiosk: (kiosk) => {
    // キオスクは放置されるので、Off（手動）のままだと更新が止まったままになる。入るときに既定へ戻す
    if (kiosk) useRefreshStore.getState().leaveOffForKiosk();
    set({ kiosk });
  },
  switchDashboard: (id) => {
    writeLastDashboardId(id);
    set({ selectedDashboardId: id, view: "main", openInEditMode: false });
  },
  setView: (view) => {
    // ダッシュボードからほかの画面へ移るときは、履歴を 1 つ積む（「戻る」1 回で、出る直前の範囲のダッシュボードへ帰るため）
    if (get().view === "main" && view !== "main") leaveDashboardInHistory();
    set({ view, kiosk: false, linkNotFound: false });
  },
  // ダッシュボードを選ぶ操作は常にメイン画面に戻る（設定/ウィザードから選択した場合も含む）
  // null は「選んでいない」状態に戻す（消したときなど）。DashboardHome が、最後に見たもの（無ければ先頭）を開く
  selectDashboard: (id, options) => {
    writeLastDashboardId(id);
    set({ selectedDashboardId: id, view: "main", openInEditMode: options?.edit === true, kiosk: false, linkNotFound: false });
  },
  autoSelectDashboard: (id) => set({ selectedDashboardId: id, openInEditMode: false }),
}));
