import { create } from "zustand";

interface UiState {
  selectedDashboardId: string | null;
  isAddWidgetModalOpen: boolean;
  selectDashboard: (id: string | null) => void;
  openAddWidgetModal: () => void;
  closeAddWidgetModal: () => void;
}

export const useUiStore = create<UiState>((set) => ({
  selectedDashboardId: null,
  isAddWidgetModalOpen: false,
  selectDashboard: (id) => set({ selectedDashboardId: id }),
  openAddWidgetModal: () => set({ isAddWidgetModalOpen: true }),
  closeAddWidgetModal: () => set({ isAddWidgetModalOpen: false }),
}));
