/**
 * 画面の状態（どの画面を見ているか、どのダッシュボードを選んでいるか）。
 * zustand（小さな状態管理ライブラリ）のストア。画面のどこからでも、同じ状態を読み書きできる。
 *
 * 【誰が使うか】App.tsx（メニュー）、DashboardListPage、DashboardView、SetupWizard、GraphLinkView。
 */
import { create } from "zustand";

import { readGraphLinkFromUrl, type GraphLink } from "../lib/graph-link";

// 画面の種類: メイン（ダッシュボード）、設定、セットアップガイド
export type AppView = "main" | "settings" | "wizard";

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
  // リンク（?dashboard=…&graph=…&range=…）で開いたグラフ。null でなければ、そのグラフ 1 つだけを画面いっぱいに出す
  graphLink: GraphLink | null;
  // リンクのグラフが見つからなかった（一覧に黄色の帯を出す）。ほかの画面へ移ると消える
  linkNotFound: boolean;
  // リンクのグラフが見つからないとき: リンクの画面をやめて、一覧を開く
  showLinkNotFound: () => void;
}

// ページを開いたときの URL。リンクなら、そのグラフの画面から始める（SaaS はログインの後も URL が残るので、同じ画面になる）
const initialLink = readGraphLinkFromUrl();

export const useUiStore = create<UiState>((set) => ({
  view: "main",
  selectedDashboardId: null,
  openInEditMode: false,
  kiosk: false,
  graphLink: initialLink.kind === "link" ? initialLink.link : null,
  linkNotFound: initialLink.kind === "broken",
  showLinkNotFound: () => set({ graphLink: null, linkNotFound: true, view: "main", selectedDashboardId: null, kiosk: false }),
  setKiosk: (kiosk) => set({ kiosk }),
  switchDashboard: (id) => set({ selectedDashboardId: id, view: "main", openInEditMode: false }),
  setView: (view) => set({ view, kiosk: false, linkNotFound: false }),
  // ダッシュボードを選ぶ操作は常にメイン画面に戻る（設定/ウィザードから選択した場合も含む）
  selectDashboard: (id, options) => set({ selectedDashboardId: id, view: "main", openInEditMode: options?.edit === true, kiosk: false, linkNotFound: false }),
}));
