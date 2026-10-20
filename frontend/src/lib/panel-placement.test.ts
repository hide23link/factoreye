import { describe, expect, it } from "vitest";

import { choosePanelPlacement, leftPanelOffset, type ViewRect } from "./panel-placement";

const base = { viewportWidth: 1280, viewportHeight: 800, shelfOpen: false, drawerTop: 156 };
const rect = (left: number, right: number, top = 200, bottom = 400): ViewRect => ({ left, right, top, bottom });

describe("choosePanelPlacement", () => {
  it("ウィジェットを選んでいなければ、右", () => {
    expect(choosePanelPlacement({ ...base, widget: null })).toBe("right");
  });

  it("左端・中央左のウィジェットは、右に出す", () => {
    expect(choosePanelPlacement({ ...base, widget: rect(16, 400) })).toBe("right");
    expect(choosePanelPlacement({ ...base, widget: rect(16, 940) })).toBe("right");
  });

  it("右端のウィジェット（右のパネルに隠れる）は、左に出す", () => {
    // 右のパネルは x=956〜1272。ウィジェットは 700〜1264
    expect(choosePanelPlacement({ ...base, widget: rect(700, 1264) })).toBe("left");
  });

  it("センサー棚が開いているときは、左の窓は棚の右隣になり、そこにも掛かるなら下", () => {
    // 左のパネルは 288〜604。ウィジェット 700〜 は掛からない → 左
    expect(choosePanelPlacement({ ...base, shelfOpen: true, widget: rect(700, 1264) })).toBe("left");
    // ウィジェット 500〜1264 は、右にも左（棚の右隣）にも掛かる → 下
    expect(choosePanelPlacement({ ...base, shelfOpen: true, widget: rect(500, 1264) })).toBe("bottom");
    expect(leftPanelOffset(true)).toBe(288);
    expect(leftPanelOffset(false)).toBe(8);
  });

  it("幅いっぱいのウィジェットは、左右どちらにも掛かるので、下", () => {
    expect(choosePanelPlacement({ ...base, widget: rect(16, 1264) })).toBe("bottom");
  });

  it("画面の外・窓より上にあるウィジェットは、重ならないので右", () => {
    expect(choosePanelPlacement({ ...base, widget: rect(16, 1264, 10, 100) })).toBe("right");
    expect(choosePanelPlacement({ ...base, widget: rect(16, 1264, 900, 1200) })).toBe("right");
  });

  it("狭い画面は、常に下", () => {
    expect(choosePanelPlacement({ ...base, viewportWidth: 600, widget: rect(16, 200) })).toBe("bottom");
  });

  it("1024px: 右端・左端・中央のどのウィジェットを選んでも、覆われない側（または下）に出る", () => {
    const b = { ...base, viewportWidth: 1024 };
    // 12 列を 3 つに分けた 3 枚（16〜330、340〜690、700〜1008）
    expect(choosePanelPlacement({ ...b, widget: rect(16, 330) })).toBe("right");
    expect(choosePanelPlacement({ ...b, widget: rect(340, 690) })).toBe("right");
    expect(choosePanelPlacement({ ...b, widget: rect(700, 1008) })).toBe("left");
  });
});
