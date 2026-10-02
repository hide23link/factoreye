import { afterEach, describe, expect, it, vi } from "vitest";

import * as api from "../lib/api";
import { useHealthStore } from "./useHealthStore";

const initialState = useHealthStore.getState();

afterEach(() => {
  useHealthStore.setState(initialState, true);
  vi.restoreAllMocks();
});

describe("useHealthStore", () => {
  it("成功時はhealthを保存しerror/loadingをクリアする", async () => {
    vi.spyOn(api, "fetchHealth").mockResolvedValue({
      status: "ok",
      timestamp: "2024-01-01T00:00:00.000Z",
      services: { database: "connected" },
    });

    await useHealthStore.getState().check();

    expect(useHealthStore.getState().health?.status).toBe("ok");
    expect(useHealthStore.getState().error).toBeNull();
    expect(useHealthStore.getState().loading).toBe(false);
  });

  it("失敗時はerrorメッセージを保存しhealthは変更しない", async () => {
    vi.spyOn(api, "fetchHealth").mockRejectedValue(new Error("network down"));

    await useHealthStore.getState().check();

    expect(useHealthStore.getState().error).toBe("network down");
    expect(useHealthStore.getState().health).toBeNull();
    expect(useHealthStore.getState().loading).toBe(false);
  });
});
