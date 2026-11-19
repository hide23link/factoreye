/**
 * 「昨日の重ね」（計器グラフ・センサーグラフで、1 日前・1 週間前の同じ時間帯を灰色の点線で重ねる）の計算。
 *
 * 取り方: 今の線と同じ間引き API を、範囲を 24 時間（先週は 7 日）前にずらして取り、点の時刻を同じだけ進めて、今の時刻の位置に重ねる。
 * 区間の始まりは、範囲の始めから数えて同じ間隔なので、ずらしても今の点と時刻がそろう。
 *
 * 【誰が使うか】components/widgets/TrendStackWidget.tsx、SensorGraphWidget.tsx、GraphViewControls.tsx（ボタンを押せるかの判定）。
 * 【引数】mode = 「比較: なし / 昨日 / 先週」（store/useGraphViewStore.ts が端末に覚える）。
 */
import type { TrendPoint } from "./trend-stack";

export type CompareMode = "none" | "yesterday" | "week";

const DAY_MS = 24 * 3_600_000;

/** 比較の種類ごとの、名前と、ずらす長さ（ミリ秒） */
export const COMPARE_OPTIONS: ReadonlyArray<{ mode: CompareMode; label: string; offsetMs: number }> = [
  { mode: "none", label: "なし", offsetMs: 0 },
  { mode: "yesterday", label: "昨日", offsetMs: DAY_MS },
  { mode: "week", label: "先週", offsetMs: 7 * DAY_MS },
];

/** 何ミリ秒ずらすか（なし＝0） */
export function compareOffsetMs(mode: CompareMode): number {
  return COMPARE_OPTIONS.find((option) => option.mode === mode)?.offsetMs ?? 0;
}

/** 比較の名前（「昨日」「先週」）。なし＝空 */
export function compareName(mode: CompareMode): string {
  return mode === "none" ? "" : (COMPARE_OPTIONS.find((option) => option.mode === mode)?.label ?? "");
}

/** 保存してあった文字が、比較の種類として正しいか（壊れた値・知らない値は なし にするため） */
export function parseCompareMode(value: unknown): CompareMode {
  return value === "yesterday" || value === "week" ? value : "none";
}

/** 表示範囲を、比較のぶん前にずらす */
export function shiftRange(range: { from: number; to: number }, mode: CompareMode): { from: number; to: number } {
  const offset = compareOffsetMs(mode);
  return { from: range.from - offset, to: range.to - offset };
}

/** 比較側の点を、今の時刻の位置へ進める */
export function shiftPointsForward(points: ReadonlyArray<TrendPoint>, mode: CompareMode): TrendPoint[] {
  const offset = compareOffsetMs(mode);
  return points.map((point) => ({ time: point.time + offset, value: point.value }));
}

/**
 * その比較を選べるか。保持期間（maxRangeMs。SaaS は 14 日、OSS は無制限）の外に出る範囲は選べない。
 * 例: 範囲の始めが 8 日前で保持 14 日 → 先週（さらに 7 日前＝15 日前）は選べず、reason に理由を返す。
 * 数十秒のずれで選べなくならないよう、1 分の余裕を見る。
 */
export function compareAvailability(
  mode: CompareMode,
  from: number,
  nowMs: number,
  maxRangeMs: number,
): { ok: boolean; reason: string | null } {
  if (mode === "none" || !Number.isFinite(maxRangeMs)) return { ok: true, reason: null };
  const shiftedFrom = from - compareOffsetMs(mode);
  if (shiftedFrom >= nowMs - maxRangeMs - 60_000) return { ok: true, reason: null };
  const days = Math.round(maxRangeMs / DAY_MS);
  return { ok: false, reason: `${compareName(mode)}の同じ時間帯が、データの保持期間（${days} 日）の外になるため選べません` };
}

/** 比較との差の文字。例: 「（差 +4.1）」。差は 今の値 − 比較の値。丸めて 0 になる差は符号を付けない */
export function describeDiff(compareValue: number, todayValue: number, format: (value: number) => string): string {
  const diff = todayValue - compareValue;
  const digits = format(Math.abs(diff));
  const sign = Number(digits) === 0 ? "" : diff > 0 ? "+" : "-";
  return `（差 ${sign}${digits}）`;
}

/**
 * カーソルの値の一覧に出す、比較の文字。例: 「昨日 62.4（差 +4.1）」。今の値が無ければ差は出さない。
 * format: 値の桁をそろえる関数（行の値と同じもの）。
 */
export function describeCompare(mode: CompareMode, compareValue: number, todayValue: number | null, format: (value: number) => string): string {
  const base = `${compareName(mode)} ${format(compareValue)}`;
  return todayValue === null ? base : `${base}${describeDiff(compareValue, todayValue, format)}`;
}
