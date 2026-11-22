import { renderHook } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it } from "vitest";

import { useTimeRangeStore } from "../store/useTimeRangeStore";
import type { Widget } from "../types";
import { LinkRangeContext, useWidgetRange } from "./useWidgetRange";

const widget = (rangeHours?: number) => ({ config: { rangeHours } }) as Pick<Widget, "config">;
const initial = useTimeRangeStore.getState().range;

afterEach(() => {
  useTimeRangeStore.setState({ range: initial });
});

describe("useWidgetRange", () => {
  it("一覧の外（ふつうのダッシュボード）は、今までどおり: ダッシュボードの期間、ウィジェット個別の期間があればそれ", () => {
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 3_600_000 } });
    expect(renderHook(() => useWidgetRange(widget())).result.current).toEqual({ mode: "relative", durationMs: 3_600_000 });
    expect(renderHook(() => useWidgetRange(widget(6))).result.current).toEqual({ mode: "relative", durationMs: 6 * 3_600_000 });
  });

  it("一覧の中は、共通の期間（固定）に差し替える。ウィジェット個別の期間・ダッシュボードの期間は使わない", () => {
    useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 3_600_000 } });
    const wrapper = ({ children }: { children: ReactNode }) => (
      <LinkRangeContext.Provider value={{ from: 1000, to: 2000 }}>{children}</LinkRangeContext.Provider>
    );
    expect(renderHook(() => useWidgetRange(widget(6)), { wrapper }).result.current).toEqual({ mode: "absolute", from: 1000, to: 2000 });
  });
});
