/**
 * グラフの見え方の設定（この端末だけ。localStorage）。サーバーの DB には保存しない。
 *
 * - showBands: 警報の帯（しきい値を超えた時間の縦の帯）を重ねるか。既定は入
 * どの計器グラフ・センサーグラフにも同じ設定が効く（見出しの切り替えを、どれで変えても全グラフが変わる）。
 *
 * 【誰が使うか】GraphViewControls（切り替え）、TrendStackWidget、SensorGraphWidget（読む）。
 */
import { create } from "zustand";

const STORAGE_KEY = "factoreye.graphView";

interface GraphViewSettings {
  showBands: boolean;
}

interface GraphViewState extends GraphViewSettings {
  setShowBands: (value: boolean) => void;
}

const DEFAULTS: GraphViewSettings = { showBands: true };

/** 保存した設定を読む。無い・壊れている・使えない環境では既定値 */
function read(): GraphViewSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<GraphViewSettings> | null;
    if (!raw || typeof raw !== "object") return DEFAULTS;
    return { showBands: typeof raw.showBands === "boolean" ? raw.showBands : DEFAULTS.showBands };
  } catch {
    return DEFAULTS;
  }
}

export const useGraphViewStore = create<GraphViewState>((set, get) => ({
  ...read(),
  setShowBands: (value) => {
    set({ showBands: value });
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ showBands: get().showBands }));
    } catch {
      // 保存できない環境でも、この画面の間は設定が効く
    }
  },
}));
