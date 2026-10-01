import { create } from "zustand";

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
