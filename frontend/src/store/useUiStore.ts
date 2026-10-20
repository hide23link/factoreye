/**
 * 画面の状態（どの画面を見ているか、どのダッシュボードを選んでいるか）。
 * zustand（小さな状態管理ライブラリ）のストア。画面のどこからでも、同じ状態を読み書きできる。
 *
 * 【誰が使うか】App.tsx（メニュー）、DashboardListPage、DashboardView、SetupWizard。
 */
import { create } from "zustand";

// 画面の種類: メイン（ダッシュボード）、設定、セットアップガイド
export type AppView = "main" | "settings" | "wizard";

interface UiState {
  view: AppView;
  selectedDashboardId: string | null;
  // 選んだダッシュボードを、編集モードで開くか（新しく作った直後に、そのまま編集に入るため）
  openInEditMode: boolean;
  setView: (view: AppView) => void;
  selectDashboard: (id: string | null, options?: { edit?: boolean }) => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "main",
  selectedDashboardId: null,
  openInEditMode: false,
  setView: (view) => set({ view }),
  // ダッシュボードを選ぶ操作は常にメイン画面に戻る（設定/ウィザードから選択した場合も含む）
  selectDashboard: (id, options) => set({ selectedDashboardId: id, view: "main", openInEditMode: options?.edit === true }),
}));
