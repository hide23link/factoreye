import { act, renderHook } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useDragSelect } from "./useDragSelect";

describe("useDragSelect", () => {
  it("押した位置から離した位置までを、昇順の範囲として渡す", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useDragSelect(onSelect));

    act(() => result.current.handlers.onMouseDown({ activeLabel: 5000 }));
    act(() => result.current.handlers.onMouseMove({ activeLabel: 2000 }));
    act(() => result.current.handlers.onMouseUp());

    // 左から右へ（逆向きに押しても、小さい方が from）
    expect(onSelect).toHaveBeenCalledWith(2000, 5000);
  });

  it("ドラッグ中は、選択の範囲を描画用に返す", () => {
    const { result } = renderHook(() => useDragSelect(() => {}));

    act(() => result.current.handlers.onMouseDown({ activeLabel: 1000 }));
    act(() => result.current.handlers.onMouseMove({ activeLabel: 3000 }));

    expect(result.current.selection).toEqual({ x1: 1000, x2: 3000 });
  });

  it("1 秒未満の幅は、選択しない", () => {
    const onSelect = vi.fn();
    const { result } = renderHook(() => useDragSelect(onSelect));

    act(() => result.current.handlers.onMouseDown({ activeLabel: 1000 }));
    act(() => result.current.handlers.onMouseMove({ activeLabel: 1500 }));
    act(() => result.current.handlers.onMouseUp());

    expect(onSelect).not.toHaveBeenCalled();
    expect(result.current.selection).toBeNull();
  });

  it("ドラッグしていなくても、マウスの位置の時刻を返す（カーソル拡大に使う）", () => {
    const { result } = renderHook(() => useDragSelect(() => {}));

    act(() => result.current.handlers.onMouseMove({ activeLabel: 7000 }));

    expect(result.current.hoverTime()).toBe(7000);
  });

  it("グラフの外に出たら、位置を忘れる", () => {
    const { result } = renderHook(() => useDragSelect(() => {}));

    act(() => result.current.handlers.onMouseMove({ activeLabel: 7000 }));
    act(() => result.current.handlers.onMouseLeave());

    expect(result.current.hoverTime()).toBeNull();
  });
});
