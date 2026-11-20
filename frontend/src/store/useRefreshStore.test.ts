import { afterEach, describe, expect, it } from "vitest";

import { useRefreshStore } from "./useRefreshStore";
import { useUiStore } from "./useUiStore";

afterEach(() => {
  useRefreshStore.setState({ choice: "graph", manualAt: 0 });
  useUiStore.setState({ kiosk: false });
  localStorage.clear();
});

describe("useRefreshStore", () => {
  it("10 秒などの選択は端末に保存する", () => {
    useRefreshStore.getState().setChoice("60");
    expect(localStorage.getItem("factoreye.refreshInterval")).toBe("60");
  });

  it("Off は保存しない（再読み込みで既定に戻る）", () => {
    useRefreshStore.getState().setChoice("60");
    useRefreshStore.getState().setChoice("off");
    expect(useRefreshStore.getState().choice).toBe("off");
    expect(localStorage.getItem("factoreye.refreshInterval")).toBe("graph");
  });

  it("選択を変える・手動更新で、現在時刻の下限（manualAt）が進む", () => {
    useRefreshStore.getState().markManualRefresh();
    expect(useRefreshStore.getState().manualAt).toBeGreaterThan(0);
  });

  it("キオスクに入るとき、Off なら既定に戻し、それ以外は変えない", () => {
    useRefreshStore.setState({ choice: "off" });
    useUiStore.getState().setKiosk(true);
    expect(useRefreshStore.getState().choice).toBe("graph");

    useRefreshStore.setState({ choice: "30" });
    useUiStore.getState().setKiosk(true);
    expect(useRefreshStore.getState().choice).toBe("30");
  });
});
