import { afterEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen } from "../../test/test-utils";
import { SensorConnectGuide } from "./SensorConnectGuide";

// 本番・ラズパイのように、画面と API が同じアドレスで配られている（VITE_API_URL が空）場合
vi.mock("../../lib/api", () => ({
  API_BASE_URL: "",
  fetchSensorReadings: vi.fn(),
}));

import * as api from "../../lib/api";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("SensorConnectGuide（センサーを登録したあとの「つなぎ方」）", () => {
  it("API のアドレスが空でも、画面を開いているアドレス（origin）を、案内と curl の例に出す", async () => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });

    renderWithQueryClient(
      <SensorConnectGuide sensor={{ id: "s1", name: "洋室 CO2", ingestKey: "mk-co2", unit: "ppm" }} onClose={() => {}} />,
    );

    const guide = await screen.findByRole("region", { name: "センサーのつなぎ方" });
    expect(guide.querySelector("pre")?.textContent).toContain(`curl -X POST ${window.location.origin}/api/ingest/readings`);
    expect(screen.getByText(window.location.origin, { selector: "code" })).toBeInTheDocument();
  });
});
