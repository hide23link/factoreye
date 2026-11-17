import { describe, expect, it } from "vitest";

import { clampPoint, moveRoom, newRoom, readFloorPlan, resizeRoom, unplacedKeys } from "./floor-plan";

const room = { id: "r1", name: "リビング", x: 10, y: 10, w: 30, h: 30 };

describe("readFloorPlan", () => {
  it("設定なしは空", () => {
    expect(readFloorPlan({})).toEqual({ rooms: [], placements: {} });
  });
  it("形のおかしい項目は捨てる", () => {
    const plan = readFloorPlan({
      floorRooms: [room, { id: "bad", name: "x", x: "1" as unknown as number, y: 0, w: 1, h: 1 }],
      floorPlacements: { a: { x: 5, y: 6 }, b: { x: NaN, y: 1 } },
    });
    expect(plan.rooms).toEqual([room]);
    expect(plan.placements).toEqual({ a: { x: 5, y: 6 } });
  });
});

describe("部屋の移動と大きさ", () => {
  it("動かしても、図の外に出ない", () => {
    expect(moveRoom(room, 100, -100)).toMatchObject({ x: 70, y: 0 });
  });
  it("大きさは、最小より小さくならず、図の外に出ない", () => {
    expect(resizeRoom(room, -100, -100)).toMatchObject({ w: 8, h: 8 });
    expect(resizeRoom(room, 100, 100)).toMatchObject({ w: 90, h: 90 });
  });
  it("新しい部屋は、すでにある部屋とずらして置き、ID が重ならない", () => {
    const next = newRoom([room, { ...room, id: "room-2" }]);
    expect(next.id).toBe("room-3");
    expect(next.x).toBeGreaterThan(4);
  });
});

describe("札", () => {
  it("位置は図の中に収める", () => {
    expect(clampPoint(-5, 200)).toEqual({ x: 1, y: 94 });
  });
  it("まだ置いていない札", () => {
    expect(unplacedKeys(["a", "b", "c"], { b: { x: 1, y: 1 }, gone: { x: 2, y: 2 } })).toEqual(["a", "c"]);
  });
});
