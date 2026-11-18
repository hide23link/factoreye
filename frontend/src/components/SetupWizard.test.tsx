import userEvent from "@testing-library/user-event";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ApiError } from "../lib/errors";
import { loadSetupProgress, saveSetupProgress } from "../lib/setup-progress";
import { useUiStore } from "../store/useUiStore";
import { renderWithQueryClient, screen, waitFor } from "../test/test-utils";
import type { Sensor } from "../types";
import { SetupWizard } from "./SetupWizard";

vi.mock("../lib/api", () => ({
  API_BASE_URL: "http://localhost:8000",
  fetchHealth: vi.fn(),
  fetchSensorReadings: vi.fn(),
  fetchSensors: vi.fn(),
  fetchDashboards: vi.fn(),
  createSensor: vi.fn(),
  createDashboard: vi.fn(),
  addWidget: vi.fn(),
}));

import * as api from "../lib/api";

const newSensor: Sensor = {
  id: "s-new",
  name: "デモセンサー",
  ingestKey: "demo-sensor-xyz",
  unit: "C",
  thresholdMinWarning: null,
  thresholdMinCritical: null,
  thresholdMaxWarning: null,
  thresholdMaxCritical: null,
  thresholdDeadBand: 0,
  enabled: true,
  createdAt: "2024-01-01T00:00:00.000Z",
  updatedAt: "2024-01-01T00:00:00.000Z",
};

const savedSensor = { id: "s-new", name: "デモセンサー", ingestKey: "demo-sensor-xyz", unit: "C" };

/** 何も届いていない状態で、ガイドを開くための準備 */
function mockNothingReceived() {
  vi.mocked(api.fetchSensors).mockResolvedValue([]);
  vi.mocked(api.fetchSensorReadings).mockResolvedValue({ readings: [], total: 0 });
  vi.mocked(api.fetchHealth).mockResolvedValue({ status: "ok", timestamp: "2024-01-01T00:00:00Z", services: { database: "connected" } });
  vi.mocked(api.fetchDashboards).mockResolvedValue([]);
}

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  window.localStorage.clear();
  vi.restoreAllMocks();
});

describe("SetupWizard", () => {
  it("段階 1 のフォームと、進み具合（0 / 4 完了）を表示する", () => {
    mockNothingReceived();

    renderWithQueryClient(<SetupWizard />);

    expect(screen.getByRole("heading", { name: "最初のグラフを出すまで" })).toBeInTheDocument();
    expect(screen.getByText("0 / 4 完了")).toBeInTheDocument();
    expect(screen.getByText("センサーを登録する")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "次へ" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "あとで続ける" })).toBeInTheDocument();
  });

  it("フォーム送信で createSensor を呼んで、段階 2（テストデータを送る）へ進む", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    vi.mocked(api.createSensor).mockResolvedValue(newSensor);

    renderWithQueryClient(<SetupWizard />);

    const nameInput = screen.getByRole("textbox", { name: /名前/ });
    await user.clear(nameInput);
    await user.type(nameInput, "テスト温度計");

    await user.click(screen.getByRole("button", { name: "次へ" }));

    await waitFor(() => expect(api.createSensor).toHaveBeenCalled());
    expect(await screen.findByText(/下のコードをパソコンで 1 回実行/)).toBeInTheDocument();
    expect(screen.getByText("1 / 4 完了")).toBeInTheDocument();
    // 段階 1 は、登録したセンサーの要約になる
    expect(screen.getByText("demo-sensor-xyz")).toBeInTheDocument();
  });

  it("API エラー時にエラーメッセージを表示する", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    vi.mocked(api.createSensor).mockRejectedValue(new ApiError(409, "POST /api/sensors failed: 409 conflict"));

    renderWithQueryClient(<SetupWizard />);

    await user.click(screen.getByRole("button", { name: "次へ" }));

    expect(
      await screen.findByText("その名前またはIngest Keyは既に使われています。別の値に変更して再試行してください。"),
    ).toBeInTheDocument();
  });

  it("段階 2 でコードタブを切り替えられ、コピーできる", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    vi.mocked(api.createSensor).mockResolvedValue(newSensor);

    renderWithQueryClient(<SetupWizard />);

    await user.click(screen.getByRole("button", { name: "次へ" }));
    await screen.findByText(/下のコードをパソコンで 1 回実行/);

    await user.click(screen.getByRole("button", { name: "Python (Raspberry Pi)" }));
    expect(screen.getByText(/factoreye_client/)).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "コピー" }));
    expect(await screen.findByRole("button", { name: "コピーしました" })).toBeInTheDocument();
  });

  it("受信待ちの表に、サーバーへの接続・受信キー・最後に届いた値（まだ無い）を出す", async () => {
    mockNothingReceived();
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByText(/接続 OK/)).toBeInTheDocument();
    expect(screen.getByText(/demo-sensor-xyz\s+登録済み/)).toBeInTheDocument();
    // 受信キーは何も確かめていないので、「有効」とは出さない
    expect(screen.queryByText(/有効/)).not.toBeInTheDocument();
    expect(screen.getByText("まだありません")).toBeInTheDocument();
    expect(screen.getByText(/受信待ち/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "次へ（値が届いたら押せます）" })).toBeDisabled();

    // 届かないときの原因は、押すと開く
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: /届かないとき/ }));
    expect(screen.getByText(/INGEST_API_KEY）が、backend の .env/)).toBeInTheDocument();
  });

  it("サーバーにつながらないときは、接続できませんと出す", async () => {
    mockNothingReceived();
    vi.mocked(api.fetchHealth).mockRejectedValue(new Error("network"));
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByText("接続できません")).toBeInTheDocument();
  });

  it("途中でやめていたら、続きから再開する（センサーはもう一度作らない）", async () => {
    mockNothingReceived();
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByText(/下のコードをパソコンで 1 回実行/)).toBeInTheDocument();
    expect(screen.getByText("1 / 4 完了")).toBeInTheDocument();
    expect(api.createSensor).not.toHaveBeenCalled();
  });

  it("値が届くと自動で段階 3 へ進み、計器盤を作って、完了まで進める", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    vi.mocked(api.fetchSensorReadings).mockResolvedValue({
      readings: [{ sensorId: "s-new", value: 23.5, recordedAt: new Date().toISOString() }],
      total: 1,
    });
    vi.mocked(api.createDashboard).mockResolvedValue({ id: "d-new", name: "はじめてのダッシュボード" } as never);
    vi.mocked(api.addWidget).mockResolvedValue({} as never);
    vi.mocked(api.fetchDashboards).mockResolvedValue([{ id: "d-new", name: "はじめてのダッシュボード" }] as never);
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    // 自動で段階 3 へ進むと、画面下のボタンが「計器盤を作る」に変わる
    await user.click(await screen.findByRole("button", { name: "計器盤を作る" }));

    await waitFor(() => expect(api.createDashboard).toHaveBeenCalledWith({ name: "はじめてのダッシュボード" }));
    // 計器（TapeGauge）と計器グラフ（TrendStack）の 2 つを置く
    await waitFor(() => expect(api.addWidget).toHaveBeenCalledTimes(2));
    expect(vi.mocked(api.addWidget).mock.calls.map((call) => call[1].type)).toEqual(["TapeGauge", "TrendStack"]);
    expect(vi.mocked(api.addWidget).mock.calls[1][1].config).toEqual({ sensorIds: ["s-new"] });

    expect(await screen.findByText("4 / 4 完了")).toBeInTheDocument();
    const viewButton = screen.getByRole("button", { name: "ダッシュボードを見る" });
    await waitFor(() => expect(viewButton).toBeEnabled());
    await user.click(viewButton);
    expect(useUiStore.getState().selectedDashboardId).toBe("d-new");
    // 最後まで終わったので、覚えた進み具合は消える
    expect(window.localStorage.getItem("factoreye.setup-guide")).toBeNull();
  });

  it("「最初からやり直す」で、段階 1 に戻る", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    await user.click(await screen.findByRole("button", { name: "最初からやり直す" }));

    expect(screen.getByText("0 / 4 完了")).toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /名前/ })).toBeInTheDocument();
    // やり直したあとは、前のセンサーの進み具合が残らない（再読み込みしても段階 1 から）
    expect(window.localStorage.getItem("factoreye.setup-guide")).toBeNull();
    expect(loadSetupProgress().step).toBe(1);
  });

  it("段階の番号の札は、済みの段階を「N 済み」と読み上げる", async () => {
    mockNothingReceived();
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByRole("img", { name: "1 済み" })).toBeInTheDocument();
  });

  it("覚えたセンサーが削除されていて、取得が 404 のときは、待ち続けず、最初からやり直すよう案内する", async () => {
    mockNothingReceived();
    vi.mocked(api.fetchSensorReadings).mockRejectedValue(new ApiError(404, "GET /api/sensors/s-new/readings failed: 404"));
    saveSetupProgress({ step: 2, sensor: savedSensor, dashboardId: null });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("登録したセンサーが見つかりません");
    expect(screen.getByRole("alert")).toHaveTextContent("最初からやり直す");

    // 案内のとおり、やり直すと段階 1 に戻り、案内は消える
    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "最初からやり直す" }));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    expect(screen.getByRole("textbox", { name: /名前/ })).toBeInTheDocument();
  });

  it("段階 4 で、作ったダッシュボードがあれば「ダッシュボードを見る」で開き、覚えた進み具合を消す", async () => {
    const user = userEvent.setup();
    mockNothingReceived();
    vi.mocked(api.fetchDashboards).mockResolvedValue([{ id: "d-keep", name: "はじめてのダッシュボード" }] as never);
    saveSetupProgress({ step: 4, sensor: savedSensor, dashboardId: "d-keep" });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByText("4 / 4 完了")).toBeInTheDocument();
    expect(window.localStorage.getItem("factoreye.setup-guide")).not.toBeNull();
    const button = screen.getByRole("button", { name: "ダッシュボードを見る" });
    await waitFor(() => expect(button).toBeEnabled());

    await user.click(button);

    expect(useUiStore.getState().selectedDashboardId).toBe("d-keep");
    expect(window.localStorage.getItem("factoreye.setup-guide")).toBeNull();
  });

  it("段階 4 で、作ったダッシュボードが削除されていたら、開けず、最初からやり直すよう案内する", async () => {
    mockNothingReceived();
    vi.mocked(api.fetchDashboards).mockResolvedValue([{ id: "d-other", name: "別のダッシュボード" }] as never);
    saveSetupProgress({ step: 4, sensor: savedSensor, dashboardId: "d-gone" });

    renderWithQueryClient(<SetupWizard />);

    expect(await screen.findByRole("alert")).toHaveTextContent("作ったダッシュボードが見つかりません");
    expect(screen.getByRole("button", { name: "ダッシュボードを見る" })).toBeDisabled();
  });
});
