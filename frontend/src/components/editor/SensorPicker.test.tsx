import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { renderWithQueryClient, screen, waitFor } from "../../test/test-utils";
import type { Sensor } from "../../types";
import { SensorPicker } from "./SensorPicker";

vi.mock("../../lib/api", () => ({
  fetchSensorReadings: vi.fn(),
  fetchSensorReadingsAggregate: vi.fn(),
}));

import * as api from "../../lib/api";

function sensor(id: string, name: string, unit = "℃"): Sensor {
  return {
    id,
    name,
    ingestKey: `key-${id}`,
    unit,
    thresholdMinWarning: null,
    thresholdMinCritical: null,
    thresholdMaxWarning: 80,
    thresholdMaxCritical: 90,
    thresholdDeadBand: 0,
    enabled: true,
    createdAt: "",
    updatedAt: "",
  };
}

const SENSORS = [sensor("s1", "成形機 温度"), sensor("s2", "ライン1 生産数", "個"), sensor("s3", "搬送機 稼働", "")];

function renderPicker(props: Partial<React.ComponentProps<typeof SensorPicker>> = {}) {
  const onToggle = vi.fn();
  const onClose = vi.fn();
  renderWithQueryClient(
    <SensorPicker sensors={SENSORS} selectedIds={[]} suited="measure" multiple onToggle={onToggle} onClose={onClose} {...props} />,
  );
  return { onToggle, onClose };
}

describe("SensorPicker", () => {
  beforeEach(() => {
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [
        { sensorId: "s", value: 92, recordedAt: "2026-10-23T00:00:00Z" },
        { sensorId: "s", value: 70, recordedAt: "2026-10-22T23:59:00Z" },
      ],
      total: 2,
    });
    vi.mocked(api.fetchSensorReadingsAggregate).mockResolvedValue({ sum: 1234, count: 10 });
  });

  it("登録済みのセンサーを、現在値つきで並べる（生産数は本日の累計、稼働は文言）", async () => {
    renderPicker();
    expect(await screen.findByText("92")).toBeInTheDocument();
    expect(await screen.findByText("1,234")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /成形機 温度/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /搬送機 稼働/ })).toBeInTheDocument();
  });

  it("検索で絞り込める（名前とキー）", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "key-s2");
    expect(screen.getByRole("button", { name: /ライン1 生産数/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /成形機 温度/ })).not.toBeInTheDocument();
  });

  it("種類で絞り込める", async () => {
    const user = userEvent.setup();
    renderPicker();
    await user.click(screen.getByRole("button", { name: "稼働" }));
    expect(screen.getByRole("button", { name: /搬送機 稼働/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /成形機 温度/ })).not.toBeInTheDocument();
  });

  it("おすすめの種類が先頭に並び、印が付く", () => {
    renderPicker({ suited: "count" });
    const rows = screen.getAllByRole("button", { name: /成形機|ライン1|搬送機/ });
    expect(rows[0]).toHaveAccessibleName(/ライン1 生産数/);
    expect(rows[0]).toHaveTextContent("おすすめ");
  });

  it("おすすめの印は、種類が混ざっているときだけ付く（全部が同じ種類なら付けない）", () => {
    renderPicker({ sensors: [sensor("a", "温度A"), sensor("b", "温度B")], suited: "measure" });
    expect(screen.queryByText("おすすめ")).not.toBeInTheDocument();
  });

  it("選択中の行は押すと「選択中」として外す側で通知する／未選択は選ぶ側で通知する", async () => {
    const user = userEvent.setup();
    const { onToggle } = renderPicker({ selectedIds: ["s1"] });
    expect(screen.getByRole("button", { name: /成形機 温度/ })).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("button", { name: /ライン1 生産数/ })).toHaveAttribute("aria-pressed", "false");
    await user.click(screen.getByRole("button", { name: /成形機 温度/ }));
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s1" }), true);
    await user.click(screen.getByRole("button", { name: /ライン1 生産数/ }));
    expect(onToggle).toHaveBeenLastCalledWith(expect.objectContaining({ id: "s2" }), false);
  });

  it("「完了」で閉じる", async () => {
    const user = userEvent.setup();
    const { onClose } = renderPicker();
    await user.click(screen.getByRole("button", { name: "完了" }));
    expect(onClose).toHaveBeenCalled();
  });

  it("1つだけ選ぶときは、今の選択に「選択中」が付く（aria-current）", () => {
    renderPicker({ multiple: false, selectedIds: ["s2"] });
    const row = screen.getByRole("button", { name: /ライン1 生産数/ });
    expect(row).toHaveAttribute("aria-current", "true");
    expect(row).toHaveTextContent("選択中");
    expect(row).not.toHaveAttribute("aria-pressed");
  });

  it("削除済みのセンサーの ID は、表示中の件数に数えない", () => {
    renderPicker({ selectedIds: ["s1", "gone"] });
    expect(screen.getByText("1 件を表示中")).toBeInTheDocument();
  });

  it("種類の絞り込みと検索を併用できる", async () => {
    const user = userEvent.setup();
    renderPicker({ sensors: [...SENSORS, sensor("s4", "乾燥炉 温度")] });
    await user.click(screen.getByRole("button", { name: "計測値" }));
    await user.type(screen.getByRole("searchbox", { name: "センサーを検索" }), "乾燥");
    expect(screen.getByRole("button", { name: /乾燥炉 温度/ })).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /成形機 温度/ })).not.toBeInTheDocument();
  });

  it("センサーが 0 件のときは、登録を案内する", () => {
    renderPicker({ sensors: [] });
    expect(screen.getByText(/センサーがまだありません/)).toBeInTheDocument();
  });

  it("取得に失敗しても、一覧は出る（値は「—」）", async () => {
    vi.mocked(api.fetchSensorReadings).mockRejectedValue(new Error("down"));
    renderPicker();
    expect(await screen.findByRole("button", { name: /成形機 温度/ })).toBeInTheDocument();
    await waitFor(() => expect(screen.getAllByText("—").length).toBeGreaterThan(0));
  });
});
