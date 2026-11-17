/**
 * 配置図（部屋の枠の上に機器の札を置く）の、位置の計算。
 * 位置・大きさは、配置図の全体に対する割合（0〜100）で持つ。画面の大きさが変わっても、同じ場所に出る。
 *
 * 【誰が使うか】components/widgets/FloorPlanWidget.tsx。
 */
import type { FloorPlacements, FloorRoom, WidgetConfig } from "../types";

// 部屋の最小の大きさ（割合）。これより小さくすると、つかめなくなる
export const MIN_ROOM_SIZE = 8;

/** 設定から、部屋と札の位置を読む（形がおかしい項目は捨てる。古い設定・設定なしは空） */
export function readFloorPlan(config: WidgetConfig): { rooms: FloorRoom[]; placements: FloorPlacements } {
  const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
  const rooms = (config.floorRooms ?? []).filter(
    (room): room is FloorRoom => typeof room?.id === "string" && typeof room.name === "string" && [room.x, room.y, room.w, room.h].every(isNumber),
  );
  const placements: FloorPlacements = {};
  for (const [key, point] of Object.entries(config.floorPlacements ?? {})) {
    if (point && isNumber(point.x) && isNumber(point.y)) placements[key] = point;
  }
  return { rooms, placements };
}

/** 値を範囲に収める */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** 札の位置を、配置図の中に収める（札の左上の点。端に貼り付かないよう 1〜99） */
export function clampPoint(x: number, y: number): { x: number; y: number } {
  return { x: clamp(x, 1, 96), y: clamp(y, 1, 94) };
}

/** 部屋を動かす（枠が図の外に出ない） */
export function moveRoom(room: FloorRoom, dx: number, dy: number): FloorRoom {
  return { ...room, x: clamp(room.x + dx, 0, 100 - room.w), y: clamp(room.y + dy, 0, 100 - room.h) };
}

/** 部屋の大きさを変える（右下の角を動かす。小さくなりすぎず、図の外に出ない） */
export function resizeRoom(room: FloorRoom, dw: number, dh: number): FloorRoom {
  return { ...room, w: clamp(room.w + dw, MIN_ROOM_SIZE, 100 - room.x), h: clamp(room.h + dh, MIN_ROOM_SIZE, 100 - room.y) };
}

/** 新しい部屋（重ならないよう、すでにある部屋の数だけずらして置く） */
export function newRoom(existing: ReadonlyArray<FloorRoom>): FloorRoom {
  const shift = (existing.length % 6) * 6;
  const used = new Set(existing.map((room) => room.id));
  let n = existing.length + 1;
  while (used.has(`room-${n}`)) n += 1;
  return { id: `room-${n}`, name: `部屋 ${n}`, x: 4 + shift, y: 6 + shift, w: 30, h: 36 };
}

/** まだ置いていない札のキー（置いた札のうち、もう無い機器の分は無視する） */
export function unplacedKeys(allKeys: ReadonlyArray<string>, placements: FloorPlacements): string[] {
  return allKeys.filter((key) => !(key in placements));
}
