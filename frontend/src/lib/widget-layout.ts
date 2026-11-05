/**
 * ウィジェットの位置とサイズを、グリッドの中に収まる値にそろえる（画面に依存しない純粋な関数）。
 * 位置（列・行）は 1 始まり、12 列グリッド。幅は 1〜列数、高さは 1〜最大の行数。
 *
 * 【誰が使うか】WidgetSettings（位置とサイズの欄）。
 */
import { GRID_COLUMNS } from "./grid-placement";

export const MAX_GRID_HEIGHT = 40;

export interface WidgetPlacement {
  column: number;
  row: number;
  width: number;
  height: number;
}

/** 入力された値を、範囲に収める。列は「列 + 幅 − 1 ≦ 列数」になるように、右にはみ出さない位置にする */
export function clampPlacement(input: WidgetPlacement): WidgetPlacement {
  const width = Math.min(Math.max(Math.round(input.width), 1), GRID_COLUMNS);
  const height = Math.min(Math.max(Math.round(input.height), 1), MAX_GRID_HEIGHT);
  const maxColumn = GRID_COLUMNS - width + 1;
  return {
    column: Math.min(Math.max(Math.round(input.column), 1), maxColumn),
    row: Math.max(Math.round(input.row), 1),
    width,
    height,
  };
}
