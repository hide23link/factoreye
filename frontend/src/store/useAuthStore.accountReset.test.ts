/**
 * アカウントが替わるとき（ログアウト・強制ログアウト・別アカウントでのログイン・管理者の閲覧の開始と終了）に、
 * 前のアカウントのデータが残らないこと、端末の設定は残ることを確かめる。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { logout } from "../lib/api";
import { readLastDashboardId, writeLastDashboardId } from "../lib/last-dashboard";
import { loadSetupProgress, saveSetupProgress } from "../lib/setup-progress";
import { queryClient } from "../queryClient";
import type { MeResponse, Widget } from "../types";
import { useCursorTimeStore } from "./useCursorTimeStore";
import { useEditorStore } from "./useEditorStore";
import { useGraphViewStore } from "./useGraphViewStore";
import { useAuthStore } from "./useAuthStore";
import { useKioskStore } from "./useKioskStore";
import { useRefreshStore } from "./useRefreshStore";
import { useThemeStore } from "./useThemeStore";
import { useTimeRangeStore } from "./useTimeRangeStore";
import { useTrendCursorStore } from "./useTrendCursorStore";
import { useUiStore } from "./useUiStore";

function me(userId: string): MeResponse {
  return {
    userId,
    email: `${userId}@example.com`,
    workspaceId: `w-${userId}`,
    workspaceName: userId,
    plan: "free",
  };
}

const SENSORS_KEY = ["sensors"];
const IMPERSONATION = { accessToken: "view", email: "u2@example.com", workspaceName: "u2", expiresAt: Date.now() + 60_000 };

/** test1 として、いろいろな状態を作る（ダッシュボードを選び、キャッシュ・編集・カーソルを入れる）。 */
function fillAccountState() {
  queryClient.setQueryData(SENSORS_KEY, [{ id: "s-test1", name: "test1 のセンサー" }]);
  queryClient.setQueryData(["dashboards"], [{ id: "d-test1" }]);
  useUiStore.getState().selectDashboard("d-test1", { edit: true });
  useEditorStore.setState({ editing: true, selectedWidgetId: "w1", history: [[{ id: "w1" } as Widget]] });
  useCursorTimeStore.getState().setTime(1_700_000_000_000, "w1");
  useTrendCursorStore.getState().setCursor("w1", 1_700_000_000_000, 3_600_000);
  writeLastDashboardId("d-test1");
  saveSetupProgress({
    step: 2,
    sensor: { id: "s1", name: "センサー", ingestKey: "key-test1", unit: "℃" },
    dashboardId: null,
  });
}

/** この端末の設定を、既定と違う値にしておく。 */
function setDeviceSettings() {
  useThemeStore.setState({ mode: "light", applied: "light" });
  useKioskStore.getState().update({ cycleSeconds: 30, cycleExcluded: ["d-x"] });
  useGraphViewStore.getState().setShowBands(false);
  useGraphViewStore.getState().setCompare("week");
  useTimeRangeStore.setState({ range: { mode: "relative", durationMs: 6 * 3_600_000 } });
  useRefreshStore.getState().setChoice("30");
}

beforeEach(() => {
  queryClient.clear();
});

afterEach(() => {
  useAuthStore.setState({ accessToken: null, me: null, impersonation: null, isInitializing: false });
  localStorage.clear();
  sessionStorage.clear();
  queryClient.clear();
  useUiStore.setState({ view: "main", selectedDashboardId: null, openInEditMode: false, kiosk: false });
  useEditorStore.getState().reset();
  useCursorTimeStore.getState().reset();
  useTrendCursorStore.getState().clearAll();
  vi.restoreAllMocks();
});

describe("ログアウトで、前のアカウントのデータが消える", () => {
  it("test1 のキャッシュ・選択中のダッシュボード・編集の状態・カーソル・最後に見たダッシュボードが残らない", () => {
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    fillAccountState();
    expect(queryClient.getQueryData(SENSORS_KEY)).toBeDefined();

    useAuthStore.getState().clearAuth();
    useAuthStore.getState().setAuth("a2", "r2", me("test2"));

    // 別のアカウントでログインしても、前の値は取れない
    expect(queryClient.getQueryData(SENSORS_KEY)).toBeUndefined();
    expect(queryClient.getQueryData(["dashboards"])).toBeUndefined();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
    expect(useUiStore.getState().openInEditMode).toBe(false);
    expect(useEditorStore.getState().editing).toBe(false);
    expect(useEditorStore.getState().selectedWidgetId).toBeNull();
    expect(useEditorStore.getState().history).toEqual([]);
    expect(useCursorTimeStore.getState().time).toBeNull();
    expect(useTrendCursorStore.getState().widgets).toEqual({});
    expect(readLastDashboardId()).toBeNull();
    // セットアップガイドの進み具合（センサーの Ingest Key を含む）も消える
    expect(loadSetupProgress().sensor).toBeNull();
  });

  it("logout()（画面のログアウト）でも、同じように消える", () => {
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    fillAccountState();

    void logout();

    expect(queryClient.getQueryData(SENSORS_KEY)).toBeUndefined();
    expect(readLastDashboardId()).toBeNull();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
  });

  it("強制ログアウト（clearAuth が、更新の失敗などで呼ばれる）でも消える", () => {
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    fillAccountState();

    useAuthStore.getState().clearAuth();

    expect(queryClient.getQueryData(["dashboards"])).toBeUndefined();
    expect(readLastDashboardId()).toBeNull();
  });
});

describe("端末の設定は残る", () => {
  it("テーマ・キオスクの設定・グラフの見え方・表示時間・更新間隔は、ログアウトしても消えない", () => {
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    setDeviceSettings();
    fillAccountState();

    useAuthStore.getState().clearAuth();

    expect(useThemeStore.getState().mode).toBe("light");
    expect(useKioskStore.getState().cycleSeconds).toBe(30);
    expect(useKioskStore.getState().cycleExcluded).toEqual(["d-x"]);
    expect(useGraphViewStore.getState().showBands).toBe(false);
    expect(useGraphViewStore.getState().compare).toBe("week");
    expect(useTimeRangeStore.getState().range).toEqual({ mode: "relative", durationMs: 6 * 3_600_000 });
    expect(useRefreshStore.getState().choice).toBe("30");
    // localStorage に書いた設定も残る
    expect(JSON.parse(localStorage.getItem("factoreye.kiosk") ?? "null")).toMatchObject({ cycleSeconds: 30 });
    expect(JSON.parse(localStorage.getItem("factoreye.graphView") ?? "null")).toMatchObject({ compare: "week" });
  });
});

describe("ログアウトを通らずに別のアカウントになるとき", () => {
  it("setAuth で利用者 ID が替わったら、同じ初期化をする", () => {
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    fillAccountState();

    useAuthStore.getState().setAuth("a2", "r2", me("test2"));

    expect(queryClient.getQueryData(SENSORS_KEY)).toBeUndefined();
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
    expect(readLastDashboardId()).toBeNull();
  });

  it("同じ利用者の再ログイン・ページを開き直したときの復元では、消さない（最後に見たダッシュボードを覚えておく）", () => {
    // 復元: 前の me が無い状態で setAuth
    writeLastDashboardId("d-keep");
    useAuthStore.getState().setAuth("a1", "r1", me("test1"));
    expect(readLastDashboardId()).toBe("d-keep");

    // 同じ利用者が、トークンの更新などで setAuth し直す
    queryClient.setQueryData(SENSORS_KEY, ["keep"]);
    useAuthStore.getState().setAuth("a1b", "r1b", me("test1"));
    expect(queryClient.getQueryData(SENSORS_KEY)).toEqual(["keep"]);
    expect(readLastDashboardId()).toBe("d-keep");
  });
});

describe("管理者の閲覧（なりかわり）", () => {
  it("閲覧の開始前と終了後に、キャッシュを消し、利用者のデータを混ぜない", () => {
    // 管理者自身のタブに残っていたデータ
    queryClient.setQueryData(SENSORS_KEY, ["admin-side"]);
    writeLastDashboardId("d-admin");

    useAuthStore.getState().setImpersonated(IMPERSONATION, me("u2"));
    expect(queryClient.getQueryData(SENSORS_KEY)).toBeUndefined(); // 開始前に消える
    expect(readLastDashboardId()).toBeNull();

    // 閲覧中に、利用者のデータを取得した
    queryClient.setQueryData(SENSORS_KEY, ["u2-sensor"]);
    useUiStore.getState().selectDashboard("d-u2");

    useAuthStore.getState().clearAuth(); // 閲覧を終える
    expect(queryClient.getQueryData(SENSORS_KEY)).toBeUndefined(); // 終了後も消える
    expect(useUiStore.getState().selectedDashboardId).toBeNull();
    expect(readLastDashboardId()).toBeNull();
  });

  it("閲覧を終えても、利用者本人のリフレッシュトークンは消さない（従来どおり）", () => {
    localStorage.setItem("factoreye_rt", "owner-refresh-token");
    useAuthStore.getState().setImpersonated(IMPERSONATION, me("u2"));

    useAuthStore.getState().clearAuth();

    expect(localStorage.getItem("factoreye_rt")).toBe("owner-refresh-token");
  });
});
