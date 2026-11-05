import { renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { Sensor } from "../types";
import { useSensorSnapshot } from "./useSensorSnapshot";

vi.mock("../lib/api", () => ({
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
}));

import * as api from "../lib/api";

function sensor(name: string, unit: string, over: Partial<Sensor> = {}): Sensor {
  return {
    id: name,
    name,
    ingestKey: name,
    unit,
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: 80,
    thresholdMaxCritical: 90,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
    ...over,
  };
}

const readings = (...values: number[]) => ({
  readings: values.map((value, i) => ({ id: i, sensorId: "s", value, recordedAt: "2026-10-23T00:00:00Z" })),
  total: values.length,
});

function run(target: Sensor, enabled = true) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  return renderHook(() => useSensorSnapshot(target, enabled), { wrapper });
}

describe("useSensorSnapshot", () => {
  beforeEach(() => {
    vi.mocked(api.fetchSensorReadings).mockReset();
    vi.mocked(api.fetchSensorReadingsAggregate).mockReset();
    vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 1234.4, count: 5 });
  });

  it("計測値: 最新の値と、しきい値に応じた点の色（新しい順の先頭が最新）", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(95, 70));
    const { result } = run(sensor("温度", "℃"));
    await waitFor(() => expect(result.current.shown).toBe("95"));
    expect(result.current.dotClass).toBe("bg-red-600");
    expect(result.current.series).toEqual([70, 95]);
  });

  it("軽故障のしきい値を超えると橙、正常は緑", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(85));
    const warn = run(sensor("温度", "℃"));
    await waitFor(() => expect(warn.result.current.dotClass).toBe("bg-amber-500"));

    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(50));
    const ok = run(sensor("温度2", "℃"));
    await waitFor(() => expect(ok.result.current.dotClass).toBe("bg-green-600"));
  });

  it("稼働: 値が 0 より大きければ「稼働中」（緑）、0 なら「停止中」（赤）", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(1));
    const on = run(sensor("搬送機 稼働", ""));
    await waitFor(() => expect(on.result.current.shown).toBe("稼働中"));
    expect(on.result.current.dotClass).toBe("bg-green-600");

    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(0));
    const off = run(sensor("搬送機2 稼働", ""));
    await waitFor(() => expect(off.result.current.shown).toBe("停止中"));
    expect(off.result.current.dotClass).toBe("bg-red-600");
  });

  it("生産数: 最新の値ではなく、本日の累計を出す", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(readings(3));
    const { result } = run(sensor("ライン1 生産数", "個"));
    await waitFor(() => expect(result.current.shown).toBe("1,234"));
  });

  it("画面に見えていない（enabled=false）あいだは取得しない。値は「—」で灰色", () => {
    const { result } = run(sensor("温度", "℃"), false);
    expect(api.fetchSensorReadings).not.toHaveBeenCalled();
    expect(result.current.shown).toBe("—");
    expect(result.current.dotClass).toBe("bg-gray-400");
  });
});
