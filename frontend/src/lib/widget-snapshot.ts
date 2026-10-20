/**
 * 「元に戻す」のための、ウィジェットの状態の比較。
 * 操作の前に保存しておいたウィジェットの一覧（スナップショット）と、今の一覧を比べて、
 * サーバーに対して何をすれば元に戻るか（削除・再作成・更新）を求める。
 *
 * 操作の種類ごとに「逆の操作」を書く代わりに、一覧の差分から求めるので、どの操作にも同じ仕組みで効く。
 * 削除したウィジェットは、同じ設定で作り直す（ID は新しくなる）。
 *
 * 【誰が使うか】useWidgetActions（元に戻す）。
 */
import type { Widget } from "../types";

export interface RestorePlan {
  /** 今はあるが、元には無いもの（元に戻すと消える） */
  deleteIds: string[];
  /** 元にはあったが、今は無いもの（作り直す） */
  recreate: Widget[];
  /** 両方にあって、中身が違うもの（元の値に更新する） */
  update: Widget[];
}

function sameContent(a: Widget, b: Widget): boolean {
  return (
    a.sensorId === b.sensorId &&
    a.gridColumn === b.gridColumn &&
    a.gridRow === b.gridRow &&
    a.gridWidth === b.gridWidth &&
    a.gridHeight === b.gridHeight &&
    JSON.stringify(a.config) === JSON.stringify(b.config)
  );
}

export function planRestore(current: Widget[], snapshot: Widget[]): RestorePlan {
  const currentById = new Map(current.map((w) => [w.id, w]));
  const snapshotIds = new Set(snapshot.map((w) => w.id));
  return {
    deleteIds: current.filter((w) => !snapshotIds.has(w.id)).map((w) => w.id),
    recreate: snapshot.filter((w) => !currentById.has(w.id)),
    update: snapshot.filter((w) => {
      const now = currentById.get(w.id);
      return now !== undefined && !sameContent(now, w);
    }),
  };
}
