import { fireEvent, render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { useCursorZoom } from "./useCursorZoom";

function Chart({
  anchor,
  onZoom,
}: {
  anchor: number | null;
  onZoom: (anchor: number, factor: number) => void;
}) {
  const ref = useCursorZoom(() => anchor, onZoom);
  return <div ref={ref} data-testid="chart" />;
}

describe("useCursorZoom", () => {
  it("Ctrl＋上へのホイールで、カーソルの時刻を中心に拡大する（倍率 0.8）", () => {
    const onZoom = vi.fn();
    const { getByTestId } = render(<Chart anchor={1234} onZoom={onZoom} />);

    fireEvent.wheel(getByTestId("chart"), { ctrlKey: true, deltaY: -100 });

    expect(onZoom).toHaveBeenCalledWith(1234, 0.8);
  });

  it("⌘＋下へのホイールで縮小する（倍率 1.25）", () => {
    const onZoom = vi.fn();
    const { getByTestId } = render(<Chart anchor={1234} onZoom={onZoom} />);

    fireEvent.wheel(getByTestId("chart"), { metaKey: true, deltaY: 100 });

    expect(onZoom).toHaveBeenCalledWith(1234, 1.25);
  });

  it("Ctrl・⌘ を押していないホイールでは、拡大縮小しない（ページのスクロールのまま）", () => {
    const onZoom = vi.fn();
    const { getByTestId } = render(<Chart anchor={1234} onZoom={onZoom} />);

    fireEvent.wheel(getByTestId("chart"), { deltaY: -100 });

    expect(onZoom).not.toHaveBeenCalled();
  });

  it("カーソルがグラフの外（時刻が無い）のときは、拡大縮小しない", () => {
    const onZoom = vi.fn();
    const { getByTestId } = render(<Chart anchor={null} onZoom={onZoom} />);

    fireEvent.wheel(getByTestId("chart"), { ctrlKey: true, deltaY: -100 });

    expect(onZoom).not.toHaveBeenCalled();
  });
});
