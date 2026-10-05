/**
 * 画面の状態（どの画面を見ているか、どのダッシュボードを選んでいるか、追加画面を開いているか）。
 * zustand（小さな状態管理ライブラリ）のストア。画面のどこからでも、同じ状態を読み書きできる。
 */
import { create } from "zustand";

// 画面の種類: メイン（ダッシュボード）、設定、セットアップガイド
export type AppView = "main" | "settings" | "wizard";

interface UiState {
  view: AppView;
  selectedDashboardId: string | null;
  isAddWidgetModalOpen: boolean;
  setView: (view: AppView) => void;
  selectDashboard: (id: string | null) => void;
  openAddWidgetModal: () => void;
  closeAddWidgetModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  view: "main",
  selectedDashboardId: null,
  isAddWidgetModalOpen: false,
  setView: (view) => set({ view }),
  // ダッシュボードを選ぶ操作は常にメイン画面に戻る（設定/ウィザードから選択した場合も含む）
  selectDashboard: (id) => set({ selectedDashboardId: id, view: "main" }),
  openAddWidgetModal: () => set({ isAddWidgetModalOpen: true }),
  closeAddWidgetModal: () => set({ isAddWidgetModalOpen: false }),
}));
