import { describe, expect, it } from "vitest";

import { choosePanelSlot, type ViewRect } from "./panel-placement";

const base = { viewportWidth: 1280, viewportHeight: 800, shelf: null, drawerTop: 156, bottomGap: 8 };
const rect = (left: number, right: number, top = 200, bottom = 400): ViewRect => ({ left, right, top, bottom });
// 既定の位置に開いたセンサー棚（左 8〜280、上 156〜792）
const dockedShelf: ViewRect = { left: 8, right: 280, top: 156, bottom: 792 };

describe("choosePanelSlot", () => {
  it("ウィジェットを選んでいなければ、右", () => {
    expect(choosePanelSlot({ ...base, widget: null })).toEqual({ placement: "right" });
  });

  it("左端・中央左のウィジェットは、右に出す", () => {
    expect(choosePanelSlot({ ...base, widget: rect(16, 400) })).toEqual({ placement: "right" });
    expect(choosePanelSlot({ ...base, widget: rect(16, 940) })).toEqual({ placement: "right" });
  });

  it("右端のウィジェットは、左端に出す", () => {
    expect(choosePanelSlot({ ...base, widget: rect(700, 1264) })).toEqual({ placement: "left", left: 8 });
  });

  it("棚が既定の位置にあるときは、左の窓は棚の右隣になり、そこにも掛かるなら下（棚の右隣から）", () => {
    expect(choosePanelSlot({ ...base, shelf: dockedShelf, widget: rect(700, 1264) })).toEqual({ placement: "left", left: 288 });
    expect(choosePanelSlot({ ...base, shelf: dockedShelf, widget: rect(500, 1264) })).toEqual({ placement: "bottom", left: 288, right: 8 });
  });

  it("幅いっぱいのウィジェットは、左右どちらにも掛かるので、下", () => {
    expect(choosePanelSlot({ ...base, widget: rect(16, 1264) })).toEqual({ placement: "bottom", left: 8, right: 8 });
  });

  it("画面の外・窓より上にあるウィジェットは、重ならないので右", () => {
    expect(choosePanelSlot({ ...base, widget: rect(16, 1264, 10, 100) })).toEqual({ placement: "right" });
    expect(choosePanelSlot({ ...base, widget: rect(16, 1264, 900, 1200) })).toEqual({ placement: "right" });
  });

  it("狭い画面は、常に下", () => {
    expect(choosePanelSlot({ ...base, viewportWidth: 600, widget: rect(16, 200) })).toEqual({ placement: "bottom", left: 8, right: 8 });
  });

  describe("センサー棚を動かしたとき", () => {
    it("棚が右の窓の位置に動いたら、右ではなく左端に出す（棚と重ならない）", () => {
      const shelfRight: ViewRect = { left: 980, right: 1252, top: 200, bottom: 700 };
      expect(choosePanelSlot({ ...base, shelf: shelfRight, widget: rect(400, 900) })).toEqual({ placement: "left", left: 8 });
    });

    it("棚が中央に動いたら、右にも左端にも出せる。右を優先", () => {
      const shelfMid: ViewRect = { left: 500, right: 772, top: 200, bottom: 700 };
      expect(choosePanelSlot({ ...base, shelf: shelfMid, widget: rect(16, 400) })).toEqual({ placement: "right" });
    });

    it("棚が下の帯に掛かるとき、下のパネルは棚を避けて、広い側に出す（棚が左なら右側、棚が右なら左側）", () => {
      const leftBottom: ViewRect = { left: 8, right: 280, top: 300, bottom: 700 };
      expect(choosePanelSlot({ ...base, shelf: leftBottom, widget: rect(16, 1264) })).toEqual({ placement: "bottom", left: 288, right: 8 });
      const rightBottom: ViewRect = { left: 1000, right: 1272, top: 300, bottom: 700 };
      const slot = choosePanelSlot({ ...base, shelf: rightBottom, widget: rect(16, 1264) });
      expect(slot).toEqual({ placement: "bottom", left: 8, right: 288 });
    });

    it("棚が下の帯に掛からない（上の方にある）ときは、下のパネルは全幅", () => {
      const top: ViewRect = { left: 8, right: 280, top: 160, bottom: 300 };
      expect(choosePanelSlot({ ...base, shelf: top, widget: rect(16, 1264) })).toEqual({ placement: "bottom", left: 8, right: 8 });
    });
  });

  it("1024px: 右端・左端・中央のどのウィジェットを選んでも、覆われない側（または下）に出る", () => {
    const b = { ...base, viewportWidth: 1024 };
    expect(choosePanelSlot({ ...b, widget: rect(16, 330) })).toEqual({ placement: "right" });
    expect(choosePanelSlot({ ...b, widget: rect(340, 690) })).toEqual({ placement: "right" });
    expect(choosePanelSlot({ ...b, widget: rect(700, 1008) })).toEqual({ placement: "left", left: 8 });
  });
});
