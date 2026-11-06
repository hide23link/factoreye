/**
 * 画面表示モード（キオスク）の設定。サイズ・収め方・自動切替を、この端末のブラウザ（localStorage）に覚える。
 * モードに入っているかどうかは useUiStore の kiosk（ここには覚えない）。
 *
 * 【誰が使うか】DashboardView（見た目に反映）、KioskBar（設定の変更）。
 */
import { create } from "zustand";

const STORAGE_KEY = "factoreye.kiosk";

/** 拡大率の選択肢（ラベルは画面に出す文字） */
export const KIOSK_SCALES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 1, label: "標準" },
  { value: 1.25, label: "125%" },
  { value: 1.5, label: "150%" },
  { value: 2, label: "200%" },
];

/** 自動切替の間隔の選択肢（秒）。0 は切り替えない */
export const KIOSK_CYCLES: ReadonlyArray<{ value: number; label: string }> = [
  { value: 0, label: "切替なし" },
  { value: 10, label: "10 秒" },
  { value: 30, label: "30 秒" },
  { value: 60, label: "1 分" },
  { value: 300, label: "5 分" },
];

interface KioskSettings {
  /** 拡大率（KIOSK_SCALES の value） */
  scale: number;
  /** true = 全体を 1 画面に収める。false = 元の大きさで並べる（はみ出す分はスクロール） */
  fit: boolean;
  /** 自動切替の間隔（秒）。0 = 切り替えない */
  cycleSeconds: number;
  /** 自動切替の対象から外すダッシュボードの ID（空 = すべて対象） */
  cycleExcluded: string[];
}

interface KioskState extends KioskSettings {
  update: (patch: Partial<KioskSettings>) => void;
}

const DEFAULTS: KioskSettings = { scale: 1, fit: true, cycleSeconds: 0, cycleExcluded: [] };

/** 保存した設定を読む。無い・壊れている・知らない値は、既定値にする */
function read(): KioskSettings {
  try {
    const raw = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as Partial<KioskSettings> | null;
    if (!raw || typeof raw !== "object") return DEFAULTS;
    return {
      scale: KIOSK_SCALES.some((s) => s.value === raw.scale) ? (raw.scale as number) : DEFAULTS.scale,
      fit: typeof raw.fit === "boolean" ? raw.fit : DEFAULTS.fit,
      cycleSeconds: KIOSK_CYCLES.some((c) => c.value === raw.cycleSeconds) ? (raw.cycleSeconds as number) : DEFAULTS.cycleSeconds,
      cycleExcluded: Array.isArray(raw.cycleExcluded) ? raw.cycleExcluded.filter((id) => typeof id === "string") : [],
    };
  } catch {
    return DEFAULTS;
  }
}

export const useKioskStore = create<KioskState>((set, get) => ({
  ...read(),
  update: (patch) => {
    set(patch);
    const { scale, fit, cycleSeconds, cycleExcluded } = get();
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ scale, fit, cycleSeconds, cycleExcluded }));
    } catch {
      // 保存できない環境（プライベートモードなど）でも、この画面の間は設定が効く
    }
  },
}));
