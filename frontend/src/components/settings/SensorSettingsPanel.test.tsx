import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { fireEvent, renderWithQueryClient, screen, waitFor, within } from "../../test/test-utils";
import { ApiError } from "../../lib/errors";
import type { Sensor } from "../../types";
import { useUiStore } from "../../store/useUiStore";
import { SensorSettingsPanel } from "./SensorSettingsPanel";

vi.mock("../../lib/api", () => ({
  fetchSensors: vi.fn(),
  createSensor: vi.fn(),
  updateSensor: vi.fn(),
  deleteSensor: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchLatestReadings: vi.fn(),
  fetchSensorReadingsDownsampled: vi.fn(),
  API_BASE_URL: "http://localhost:8000",
}));

import * as api from "../../lib/api";

const sensor: Sensor = {
  id: "s1",
  name: "圧力計A-1",
  ingestKey: "sensor-abc",
  unit: "MPa",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: 10,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

// 一覧の各行が 1 時間分の区間データを取る。既定は「データなし」
beforeEach(() => {
  vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 120, buckets: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const NO_READINGS = { readings: [], total: 0 };

/** 一覧のセンサーの名前を押して、右の詳細の欄を開く。戻り値は詳細の欄 */
async function openDetail(user: ReturnType<typeof userEvent.setup>, name: string) {
  await user.click(await screen.findByRole("button", { name: `${name} の詳細` }));
  return screen.getByRole("complementary", { name: `${name} の詳細` });
}

/** 詳細の欄の「詳しい設定」（Ingest Key・有効/無効・削除）を開く */
async function openAdvanced(user: ReturnType<typeof userEvent.setup>, detail: HTMLElement) {
  await user.click(within(detail).getByText("詳しい設定"));
}

describe("SensorSettingsPanel", () => {
  it("センサー一覧を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    expect(await screen.findByText("圧力計A-1")).toBeInTheDocument();
    // 重故障の上限 10 だけ → 正常な範囲は「≤ 10」。Ingest Key は一覧に出さず、詳細の「詳しい設定」に出す
    expect(screen.getByText("≤ 10")).toBeInTheDocument();
    expect(screen.queryByText("sensor-abc")).not.toBeInTheDocument();
  });

  it("表の列は、名前・種類・今の値・直近 1 時間・1h 最低 — 最高・しきい値・最終受信・状態", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText("圧力計A-1");
    const headers = screen.getAllByRole("columnheader").map((th) => th.textContent);
    expect(headers).toEqual(["名前", "種類", "今の値", "直近 1 時間", "1h 最低 — 最高", "しきい値", "最終受信", "状態"]);
  });

  it("直近 1 時間の区間データから、最低 — 最高を出す。まだ受信が無いセンサーの今の値は「---」", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({
      bucketSeconds: 120,
      buckets: [
        { start: "2026-11-18T00:00:00Z", avg: 5, min: 4, max: 6, count: 3 },
        { start: "2026-11-18T00:02:00Z", avg: 7, min: 6, max: 9, count: 3 },
      ],
    });
    renderWithQueryClient(<SensorSettingsPanel />);

    expect(await screen.findByText("4 — 9")).toBeInTheDocument();
    const row = screen.getByText("圧力計A-1").closest("tr") as HTMLElement;
    expect(within(row).getByText("---")).toBeInTheDocument();
    expect(within(row).getByText(/未受信/)).toBeInTheDocument();
  });

  it("「＋センサーを追加」を押すと、追加のフォームが開く（センサーがあるときは、最初は閉じている）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText("圧力計A-1");
    expect(screen.queryByLabelText("Ingest Key")).not.toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "＋センサーを追加" }));
    expect(screen.getByLabelText("Ingest Key")).toBeInTheDocument();
  });

  it("「つなぎ方」を押すと、セットアップガイドの画面へ移る", async () => {
    const user = userEvent.setup();
    useUiStore.setState({ view: "settings" });
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText("圧力計A-1");
    await user.click(screen.getByRole("button", { name: "つなぎ方" }));
    expect(useUiStore.getState().view).toBe("wizard");
  });

  it("センサーが0件の場合は案内文を表示する", async () => {
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<SensorSettingsPanel />);

    expect(await screen.findByText(/まだセンサーが登録されていません/)).toBeInTheDocument();
  });

  it("フォームに入力して追加するとcreateSensorが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() =>
      expect(api.createSensor).toHaveBeenCalledWith(
        expect.objectContaining({ name: "圧力計A-1", unit: "°C" }),
      ),
    );
  });

  it("センサーの種類を選ぶと、単位の初期値が入る（生産数は「個」）。選んだ種類で登録できる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor).mockResolvedValue({ ...sensor, name: "ライン1", unit: "個" });
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    const kinds = within(screen.getByRole("group", { name: "センサーの種類から始める" }));
    await user.click(kinds.getByRole("button", { name: /生産数/ }));
    expect(kinds.getByRole("button", { name: /生産数/ })).toHaveAttribute("aria-pressed", "true");

    await user.type(screen.getByLabelText("名前"), "ライン1");
    await user.click(screen.getByRole("button", { name: "追加" }));
    await waitFor(() => expect(api.createSensor).toHaveBeenCalledWith(expect.objectContaining({ name: "ライン1", unit: "個" })));
  });

  it("登録に成功すると「つなぎ方」の案内が出て、データが届くまで待つ表示になる。閉じられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    const guide = await screen.findByRole("region", { name: "センサーのつなぎ方" });
    expect(within(guide).getByText(/圧力計A-1」を登録しました/)).toBeInTheDocument();
    expect(within(guide).getByText("sensor-abc")).toBeInTheDocument();
    expect(await within(guide).findByText(/データが届くのを待っています/)).toBeInTheDocument();
    // 送信コードの例に、登録したセンサーの Ingest Key が入っている
    expect(guide.querySelector("pre")?.textContent).toContain('"ingestKey": "sensor-abc"');

    await user.click(within(guide).getByRole("button", { name: "閉じる" }));
    expect(screen.queryByRole("region", { name: "センサーのつなぎ方" })).not.toBeInTheDocument();
  });

  it("最初のデータが届くと、案内が「届きました」に変わる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [{ sensorId: "s1", value: 25.3, recordedAt: "2024-01-01T00:00:00.000Z" }],
      total: 1,
    });
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(await screen.findByText(/最初のデータが届きました（25.3 MPa）/)).toBeInTheDocument();
  });

  async function registerSensor(user: ReturnType<typeof userEvent.setup>, name: string) {
    await user.type(screen.getByLabelText("名前"), name);
    await user.click(screen.getByRole("button", { name: "追加" }));
  }

  it("登録に失敗したときは、つなぎ方の案内を出さない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockRejectedValue(new Error("boom"));
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await registerSensor(user, "圧力計A-1");
    await waitFor(() => expect(api.createSensor).toHaveBeenCalled());
    expect(screen.queryByRole("region", { name: "センサーのつなぎ方" })).not.toBeInTheDocument();
  });

  it("続けて登録すると、案内は新しいセンサーのものに切り替わる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor)
      .mockResolvedValueOnce(sensor)
      .mockResolvedValueOnce({ ...sensor, id: "s2", name: "流量計B", ingestKey: "sensor-xyz" });
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await registerSensor(user, "圧力計A-1");
    expect(await screen.findByText(/圧力計A-1」を登録しました/)).toBeInTheDocument();
    await registerSensor(user, "流量計B");

    const guide = await screen.findByRole("region", { name: "センサーのつなぎ方" });
    expect(within(guide).getByText(/流量計B」を登録しました/)).toBeInTheDocument();
    expect(within(guide).getByText("sensor-xyz")).toBeInTheDocument();
  });

  it("案内のコードの例は、タブで切り替えられる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await registerSensor(user, "圧力計A-1");
    const guide = await screen.findByRole("region", { name: "センサーのつなぎ方" });
    expect(guide.querySelector("pre")?.textContent).toContain("curl");
    await user.click(within(guide).getByRole("button", { name: "Python (Raspberry Pi)" }));
    expect(guide.querySelector("pre")?.textContent).toContain("FactorEyeClient");
    expect(guide.querySelector("pre")?.textContent).toContain('"sensor-abc"');
  });

  it("コピーに失敗したら、そう伝える。成功したら「コピーしました」", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await registerSensor(user, "圧力計A-1");
    const guide = await screen.findByRole("region", { name: "センサーのつなぎ方" });

    const writeText = vi.fn().mockRejectedValueOnce(new Error("denied")).mockResolvedValueOnce(undefined);
    Object.defineProperty(navigator, "clipboard", { value: { writeText }, configurable: true });
    await user.click(within(guide).getByRole("button", { name: "📋 コピー" }));
    expect(await within(guide).findByRole("alert")).toHaveTextContent("コピーできませんでした");

    await user.click(within(guide).getByRole("button", { name: "📋 コピー" }));
    expect(await within(guide).findByRole("button", { name: "✔ コピーしました" })).toBeInTheDocument();
    expect(writeText).toHaveBeenLastCalledWith("sensor-abc");
  });

  it("案内を出しているセンサーを削除したら、案内も閉じる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.fetchSensorReadings).mockResolvedValue(NO_READINGS);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    vi.mocked(api.deleteSensor).mockResolvedValue(undefined);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText("圧力計A-1");
    await user.click(screen.getByRole("button", { name: "＋センサーを追加" }));
    await registerSensor(user, "圧力計A-1");
    await screen.findByRole("region", { name: "センサーのつなぎ方" });

    const detail = await openDetail(user, "圧力計A-1");
    await openAdvanced(user, detail);
    await user.click(within(detail).getByRole("button", { name: "削除" }));
    await user.click(within(await screen.findByRole("dialog")).getByRole("button", { name: "削除" }));

    await waitFor(() => expect(api.deleteSensor).toHaveBeenCalledWith("s1"));
    await waitFor(() => expect(screen.queryByRole("region", { name: "センサーのつなぎ方" })).not.toBeInTheDocument());
  });

  it("詳細の欄に、しきい値バーが出る（しきい値が無ければ「しきい値なし」）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor, { ...sensor, id: "s2", name: "流量", thresholdMaxCritical: null }]);
    renderWithQueryClient(<SensorSettingsPanel />);

    const detail = await openDetail(user, "圧力計A-1");
    expect(within(detail).getByRole("img", { name: /しきい値: .*重故障/ })).toBeInTheDocument();
    const other = await openDetail(user, "流量");
    expect(within(other).getByText("しきい値なし")).toBeInTheDocument();
  });

  it("Free Tier 上限（402）に達すると上限の案内を表示する", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockRejectedValue(
      new Error('POST /api/sensors failed: 402 {"detail":"free tier limit reached (10 sensors)"}'),
    );
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(await screen.findByText(/センサー上限（10個）に達しました/)).toBeInTheDocument();
  });

  it("有効/無効トグルをクリックするとupdateSensorが呼ばれる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue({ ...sensor, enabled: false });
    renderWithQueryClient(<SensorSettingsPanel />);

    const detail = await openDetail(user, "圧力計A-1");
    await openAdvanced(user, detail);
    await user.click(within(detail).getByRole("button", { name: "有効" }));

    expect(api.updateSensor).toHaveBeenCalledWith("s1", { enabled: false });
  });

  it("削除は確認ダイアログで「削除」を押した場合のみ deleteSensor を呼ぶ", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.deleteSensor).mockResolvedValue(undefined);
    renderWithQueryClient(<SensorSettingsPanel />);

    const detail = await openDetail(user, "圧力計A-1");
    await openAdvanced(user, detail);
    await user.click(within(detail).getByRole("button", { name: "削除" }));
    expect(api.deleteSensor).not.toHaveBeenCalled();
    expect(screen.getByRole("dialog")).toHaveTextContent("元に戻せません");

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "キャンセル" }));
    expect(api.deleteSensor).not.toHaveBeenCalled();

    await user.click(within(detail).getByRole("button", { name: "削除" }));
    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "削除" }));
    expect(api.deleteSensor).toHaveBeenCalledWith("s1");
  });

  it("未入力のまま追加を押すと、理由を表示する（黙って何も起きない状態にしない）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.click(screen.getByRole("button", { name: "追加" }));

    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力してください");
    expect(api.createSensor).not.toHaveBeenCalled();
  });

  it("編集: 名前を空にして保存しようとすると理由を出し、保存しない。Enter で保存、Esc でキャンセルできる", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    const name = screen.getByRole("textbox", { name: "センサー名" });
    await user.clear(name);
    await user.keyboard("{Enter}");
    expect(screen.getByRole("alert")).toHaveTextContent("名前を入力してください");
    expect(api.updateSensor).not.toHaveBeenCalled();

    await user.type(name, "圧力計B");
    await user.keyboard("{Enter}");
    await waitFor(() => expect(api.updateSensor).toHaveBeenCalledWith("s1", expect.objectContaining({ name: "圧力計B" })));
  });

  it("編集: しきい値の大小が逆だと保存せず、理由を出す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    await user.type(screen.getByRole("spinbutton", { name: "軽故障の上限" }), "20"); // 重故障の上限は 10
    await user.click(screen.getByRole("button", { name: "保存" }));

    expect(screen.getByRole("alert")).toHaveTextContent("しきい値の大小");
    expect(api.updateSensor).not.toHaveBeenCalled();
  });

  it("保存の失敗（409・500）は、API の生のメッセージではなく日本語で出す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockRejectedValue(new ApiError(500, "PUT /api/sensors/s1 failed: 500 Traceback"));
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    await user.click(screen.getByRole("button", { name: "保存" }));

    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("センサーの保存に失敗しました");
    expect(alert).not.toHaveTextContent("Traceback");
  });

  it("作成フォームの単位は、プルダウンで候補をすべて選べる（°C 以外も選べる）", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    const select = screen.getByRole("combobox", { name: "単位" });
    expect(within(select).getAllByRole("option").length).toBeGreaterThan(20);
    await user.type(screen.getByLabelText("名前"), "圧力計A-1");
    await user.selectOptions(select, "MPa");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalledWith(expect.objectContaining({ unit: "MPa" })));
  });

  it("候補にない既存の単位（psi）は、編集しても消えず、そのまま保存できる", async () => {
    const user = userEvent.setup();
    const odd = { ...sensor, unit: "psi" };
    vi.mocked(api.fetchSensors).mockResolvedValue([odd]);
    vi.mocked(api.updateSensor).mockResolvedValue(odd);
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    expect(screen.getByRole("textbox", { name: "単位（自由入力）" })).toHaveValue("psi");
    await user.click(screen.getByRole("button", { name: "保存" }));

    await waitFor(() => expect(api.updateSensor).toHaveBeenCalledWith("s1", expect.objectContaining({ unit: "psi" })));
  });

  it("名前・単位の前後の空白は、送る前に取り除く", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([]);
    vi.mocked(api.createSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await screen.findByText(/まだセンサーが登録されていません/);
    await user.type(screen.getByLabelText("名前"), "  圧力計A-1  ");
    await user.selectOptions(screen.getByRole("combobox", { name: "単位" }), "その他（自由入力）");
    await user.type(screen.getByRole("textbox", { name: "単位（自由入力）" }), " psi ");
    await user.click(screen.getByRole("button", { name: "追加" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalledWith(expect.objectContaining({ name: "圧力計A-1", unit: "psi" })));
  });

  it("編集: 日本語入力の変換確定の Enter では保存しない", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    const name = screen.getByRole("textbox", { name: "センサー名" });

    fireEvent.keyDown(name, { key: "Enter", isComposing: true });
    fireEvent.keyDown(name, { key: "Enter", keyCode: 229 });
    expect(api.updateSensor).not.toHaveBeenCalled();

    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(api.updateSensor).toHaveBeenCalled());
  });

  it("編集: Esc でキャンセルすると、入力途中の値を捨てて元の値に戻る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    await openDetail(user, "圧力計A-1");
    const name = screen.getByRole("textbox", { name: "センサー名" });
    await user.clear(name);
    await user.type(name, "途中の名前");
    expect(name).toHaveValue("途中の名前");
    await user.keyboard("{Escape}");
    expect(screen.getByRole("textbox", { name: "センサー名" })).toHaveValue("圧力計A-1");
  });

  it("詳細: 「取り消す」で、入力途中の値を保存してある値に戻す", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    renderWithQueryClient(<SensorSettingsPanel />);

    const detail = await openDetail(user, "圧力計A-1");
    await user.type(within(detail).getByRole("spinbutton", { name: "軽故障の上限" }), "7");
    await user.click(within(detail).getByRole("button", { name: "取り消す" }));
    expect(within(detail).getByRole("spinbutton", { name: "軽故障の上限" })).toHaveValue(null);
    expect(api.updateSensor).not.toHaveBeenCalled();
  });

  it("詳細: しきい値を入れて保存すると、updateSensor に 4 つのしきい値と不感帯を送る", async () => {
    const user = userEvent.setup();
    vi.mocked(api.fetchSensors).mockResolvedValue([sensor]);
    vi.mocked(api.updateSensor).mockResolvedValue(sensor);
    renderWithQueryClient(<SensorSettingsPanel />);

    const detail = await openDetail(user, "圧力計A-1");
    await user.type(within(detail).getByRole("spinbutton", { name: "軽故障の上限" }), "8");
    await user.click(within(detail).getByRole("button", { name: "保存" }));
    await waitFor(() =>
      expect(api.updateSensor).toHaveBeenCalledWith(
        "s1",
        expect.objectContaining({ thresholdMaxWarning: 8, thresholdMaxCritical: 10, thresholdMinWarning: null, thresholdMinCritical: null }),
      ),
    );
  });

  describe("検索・絞り込み・機器ごとのグループ・詳細", () => {
    const device = { deviceId: "d1", deviceName: "env-youshitsu" };
    const co2: Sensor = { ...sensor, id: "s2", name: "洋室 CO2", ingestKey: "mk-co2", unit: "ppm", thresholdMaxCritical: 1000, ...device };
    const temp: Sensor = { ...sensor, id: "s3", name: "洋室 温度", ingestKey: "mk-temp", unit: "℃", thresholdMaxCritical: null, ...device };
    const alone: Sensor = { ...sensor, id: "s4", name: "単独センサー", ingestKey: "mk-alone", thresholdMaxCritical: null };
    const fresh = (id: string, value: number) => ({ sensorId: id, value, recordedAt: new Date(Date.now() - 10_000).toISOString() });

    function setup() {
      vi.mocked(api.fetchSensors).mockResolvedValue([co2, temp, alone]);
      // 洋室 CO2 は受信中（しきい値の外）、洋室 温度 は 1 時間前で止まっている、単独は未受信
      vi.mocked(api.fetchLatestReadings).mockResolvedValue({
        readings: [fresh("s2", 1050), { sensorId: "s3", value: 21, recordedAt: new Date(Date.now() - 3_600_000).toISOString() }],
        total: 2,
      });
      vi.mocked(api.fetchSensorReadingsDownsampled).mockResolvedValue({ bucketSeconds: 60, buckets: [] });
    }

    it("機器ごとの見出しを出し、名前の下に今の値と受信の状態を出す", async () => {
      setup();
      renderWithQueryClient(<SensorSettingsPanel />);

      expect(await screen.findByText("env-youshitsu")).toBeInTheDocument();
      expect(screen.getByText("機器なし")).toBeInTheDocument();
      // 状態の列: 洋室 CO2 は受信中でしきい値の外、洋室 温度 は 1 時間前で受信なし、単独は未受信
      const rowOf = (name: string) => screen.getByText(name).closest("tr") as HTMLElement;
      expect(await within(rowOf("洋室 CO2")).findByText(/しきい値の外/)).toBeInTheDocument();
      expect(within(rowOf("洋室 温度")).getByText(/受信なし/)).toBeInTheDocument();
      expect(within(rowOf("単独センサー")).getByText(/未受信/)).toBeInTheDocument();
      // 今の値。受信が止まっているセンサーは「---」（最後の値は出さない）
      expect(within(rowOf("洋室 CO2")).getByText("1050")).toBeInTheDocument();
      expect(within(rowOf("洋室 温度")).getByText("---")).toBeInTheDocument();
    });

    it("絞り込みに「しきい値の外」がある。受信中で今の値がしきい値の外のものだけ出す", async () => {
      const user = userEvent.setup();
      setup();
      renderWithQueryClient(<SensorSettingsPanel />);
      await screen.findByText("洋室 CO2");

      await user.click(await screen.findByRole("button", { name: /^しきい値の外 1$/ }));
      expect(screen.getByText("洋室 CO2")).toBeInTheDocument();
      expect(screen.queryByText("洋室 温度")).not.toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /しきい値あり/ })).not.toBeInTheDocument();
    });

    it("機器が 4 つ以上あると、最初の 3 機器だけ開き、「ほかの N 機器を開く」で残りを出す", async () => {
      const user = userEvent.setup();
      const many = ["a", "b", "c", "d", "e"].map((x) => ({ ...sensor, id: `m-${x}`, name: `セ-${x}`, ingestKey: `k-${x}`, deviceId: `dev-${x}`, deviceName: `env-${x}` }));
      vi.mocked(api.fetchSensors).mockResolvedValue(many);
      renderWithQueryClient(<SensorSettingsPanel />);

      expect(await screen.findByText("セ-a")).toBeInTheDocument();
      expect(screen.getByText("セ-c")).toBeInTheDocument();
      expect(screen.queryByText("セ-d")).not.toBeInTheDocument();
      await user.click(screen.getByRole("button", { name: "ほかの 2 機器を開く" }));
      expect(screen.getByText("セ-e")).toBeInTheDocument();
      expect(screen.queryByRole("button", { name: /ほかの/ })).not.toBeInTheDocument();
    });

    it("絞り込みのボタンは件数つき。押すと、条件に合うものだけにする", async () => {
      const user = userEvent.setup();
      setup();
      renderWithQueryClient(<SensorSettingsPanel />);
      await screen.findByText("洋室 CO2");

      await user.click(await screen.findByRole("button", { name: /^受信中 1$/ }));

      expect(screen.getByText("洋室 CO2")).toBeInTheDocument();
      expect(screen.queryByText("洋室 温度")).not.toBeInTheDocument();
      expect(screen.queryByText("単独センサー")).not.toBeInTheDocument();
      // 止まっている = 受信が古い + まだ無い
      expect(screen.getByRole("button", { name: /^止まっている 2$/ })).toBeInTheDocument();
    });

    it("検索の文字で絞る。合うものが無ければ案内を出す", async () => {
      const user = userEvent.setup();
      setup();
      renderWithQueryClient(<SensorSettingsPanel />);
      await screen.findByText("洋室 CO2");

      await user.type(screen.getByRole("searchbox", { name: "センサーを絞り込む" }), "co2");
      expect(screen.getByText("洋室 CO2")).toBeInTheDocument();
      expect(screen.queryByText("洋室 温度")).not.toBeInTheDocument();

      await user.clear(screen.getByRole("searchbox", { name: "センサーを絞り込む" }));
      await user.type(screen.getByRole("searchbox", { name: "センサーを絞り込む" }), "存在しない");
      expect(screen.getByText("該当するセンサーはありません。")).toBeInTheDocument();
    });

    it("名前を押すと、右に詳細の欄（保存してあるしきい値入り）が出る。「閉じる」で閉じる", async () => {
      const user = userEvent.setup();
      setup();
      renderWithQueryClient(<SensorSettingsPanel />);

      await user.click(await screen.findByRole("button", { name: "洋室 CO2 の詳細" }));
      const panel = screen.getByRole("complementary", { name: "洋室 CO2 の詳細" });
      expect(within(panel).getByRole("spinbutton", { name: "重故障の上限" })).toHaveValue(1000);

      await user.click(within(panel).getByRole("button", { name: "詳細を閉じる" }));
      expect(screen.queryByRole("complementary", { name: "洋室 CO2 の詳細" })).not.toBeInTheDocument();
    });
  });
});
