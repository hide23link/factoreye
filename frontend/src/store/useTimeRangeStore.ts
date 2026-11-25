/**
 * ダッシュボードのグラフの表示時間範囲（Zustand）。
 *
 * - 範囲はダッシュボードに 1 つ。SensorGraph と MultiSensorComparison は、この範囲に従う
 * - 範囲は URL（?range=1h / ?from=…&to=…）に反映する。リンクで同じ表示を開ける
 * - 利用者が範囲を変える操作（グラフのドラッグ・ホイール・ダブルクリック・時刻の軸のドラッグ、上部の期間のボタン・＋ － ◀ ▶・今など）は、
 *   ブラウザの履歴に 1 つ積む（pushRange）。「戻る」で 1 つ前の範囲に戻れる（followBrowserBack が URL から範囲を読み直す）
 * - 範囲を書いた履歴には、どのダッシュボードのものかの印（history.state）を付ける。ダッシュボードを出て別の画面へ移った後に
 *   「戻る」を押すと、その印のダッシュボードへ帰る（画面の切り替えは URL を変えないので、印が無いと「戻る」が空振りするため）
 * - 範囲はダッシュボードの設定（サーバー側）には保存しないが、最後に見ていた「直近」の範囲は
 *   この端末の localStorage に残す（固定の期間は残さない）。次に開いたとき、URL に指定が無ければそれを使う
 *   （毎回「直近 1 時間」に戻ると不便、という利用者の要望のため）
 *
 * 【誰が使うか】DashboardView、TimeRangeControls、グラフ系の2つのウィジェット。
 */
import { create } from "zustand";

import { DEFAULT_RANGE, fromSearchParams, toSearchParams, type TimeRange } from "../lib/timeRange";

// localStorage に保存するときの鍵の名前
const TIME_RANGE_KEY = "factoreye_time_range";

interface TimeRangeState {
  range: TimeRange;
  /** 範囲を変える。URL と localStorage も同じ内容に書き換える（URL の履歴は増やさない） */
  setRange: (range: TimeRange) => void;
  /** 範囲を変え、ブラウザの履歴に 1 つ積む（「戻る」で今の範囲に戻れる）。拡大・移動の操作で使う */
  pushRange: (range: TimeRange) => void;
}

function isValidTimeRange(value: unknown): value is TimeRange {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  if (v.mode === "relative") return typeof v.durationMs === "number" && v.durationMs > 0;
  if (v.mode === "absolute") {
    return typeof v.from === "number" && typeof v.to === "number" && v.to > v.from;
  }
  return false;
}

/** 最後に見ていた範囲を localStorage から読む。保存が無い・壊れている・使えない環境では null */
function readStoredRange(): TimeRange | null {
  try {
    const raw = localStorage.getItem(TIME_RANGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    // 以前の版が保存した固定の期間は使わない（開くと過去の日時のままになるため）
    return isValidTimeRange(parsed) && parsed.mode === "relative" ? parsed : null;
  } catch {
    return null;
  }
}

/** 範囲を localStorage に保存する（使えない環境では無視） */
function writeStoredRange(range: TimeRange) {
  try {
    localStorage.setItem(TIME_RANGE_KEY, JSON.stringify(range));
  } catch {
    // noop
  }
}

// このタブで URL に書いた範囲（sessionStorage は、同じタブの再読み込みでは残り、新しいタブ・ホーム画面のショートカットでは空）
const SESSION_URL_KEY = "factoreye.timeRange.url";

/** URL のクエリのうち、範囲の部分だけを文字にする（比べるため） */
function rangeQueryOf(search: string): string {
  const params = new URLSearchParams(search);
  return ["range", "from", "to"].map((key) => `${key}=${params.get(key) ?? ""}`).join("&");
}

/** このタブで URL に書いた範囲として覚える（再読み込みのとき、固定の期間を使ってよいかの判定に使う） */
function rememberUrlRange(search: string) {
  try {
    sessionStorage.setItem(SESSION_URL_KEY, rangeQueryOf(search));
  } catch {
    // 覚えられなくても、URL の書き換えはできている
  }
}

/** 履歴の印の鍵。値は、その履歴を書いたダッシュボードの ID */
const DASHBOARD_MARK = "factoreyeDashboard";

// 今開いているダッシュボードの ID（開いていなければ null）。書く履歴の印に使う
let openDashboardId: string | null = null;

/** 書く履歴に付ける印（ダッシュボードを開いていなければ印なし） */
function historyMark(): Record<string, string> | null {
  return openDashboardId === null ? null : { [DASHBOARD_MARK]: openDashboardId };
}

/** 履歴の印から、ダッシュボードの ID を読む。印の無い履歴（ほかの画面・アプリの外）は null */
function dashboardOfMark(state: unknown): string | null {
  if (typeof state !== "object" || state === null) return null;
  const id = (state as Record<string, unknown>)[DASHBOARD_MARK];
  return typeof id === "string" ? id : null;
}

/**
 * 範囲の部分だけを、URL のクエリに書き換える（ほかのクエリは残す）。
 * history = "replace" は今の履歴を書き換え、"push" は履歴を 1 つ積む（「戻る」で前の範囲に戻れる）
 */
function writeUrl(range: TimeRange, history: "replace" | "push" = "replace") {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("range");
    url.searchParams.delete("from");
    url.searchParams.delete("to");
    toSearchParams(range).forEach((value, key) => url.searchParams.set(key, value));
    // 同じ範囲のまま（拡大の上限に当たったなど）は、履歴を積まない（「戻る」を押しても画面が変わらない履歴になるため）
    if (history === "push" && url.toString() !== window.location.href) window.history.pushState(historyMark(), "", url.toString());
    else window.history.replaceState(historyMark(), "", url.toString());
    rememberUrlRange(url.search);
  } catch {
    // URL を書き換えられない環境（プレビューなど）では、画面の状態だけを使う
  }
}

/** URL から範囲の部分と印を消す（画面を離れるとき。今の履歴は、ダッシュボードではない画面のものになる） */
function clearUrl() {
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("range");
    url.searchParams.delete("from");
    url.searchParams.delete("to");
    window.history.replaceState(null, "", url.toString());
  } catch {
    // 上と同じく、書けなくても画面の動作には影響させない
  }
}

/** 範囲を画面の状態・URL・localStorage に書く（setRange と pushRange の共通） */
function applyRange(set: (state: Pick<TimeRangeState, "range">) => void, range: TimeRange, history: "replace" | "push") {
  set({ range });
  writeUrl(range, history);
  // 保存するのは「直近」の範囲だけ。固定の期間（開始〜終了の日時）を残すと、次に開いたとき
  // 過去の日時のままデータが無く、グラフが空になる
  if (range.mode === "relative") writeStoredRange(range);
}

export const useTimeRangeStore = create<TimeRangeState>()((set) => ({
  range: DEFAULT_RANGE,
  setRange: (range) => applyRange(set, range, "replace"),
  pushRange: (range) => applyRange(set, range, "push"),
}));

// ホイールを続けて回したときは、履歴を 1 つにまとめる（1 目盛りごとに積むと、「戻る」を何回も押すことになるため）
const WHEEL_MERGE_MS = 800;
let lastWheelAt = 0;

/** Ctrl（⌘）＋ホイールでの拡大・縮小。回し始めだけ履歴を積み、続けて回している間は書き換える */
export function setRangeByWheel(range: TimeRange) {
  const now = Date.now();
  const store = useTimeRangeStore.getState();
  if (now - lastWheelAt > WHEEL_MERGE_MS) store.pushRange(range);
  else store.setRange(range);
  lastWheelAt = now;
}

/** URL の範囲を読む（無ければ、この端末で最後に見ていた直近の範囲、それも無ければ既定） */
function rangeInUrl(): TimeRange {
  return fromSearchParams(window.location.search) ?? readStoredRange() ?? DEFAULT_RANGE;
}

/**
 * ブラウザの「戻る」「進む」で、履歴の範囲を画面に戻す。アプリの画面の一番外側（App）で、ずっと登録しておく。
 * - 開いているダッシュボードの履歴なら、URL の範囲を読み直す
 * - ダッシュボードの外（設定など）や、別のダッシュボードを見ているときに、ダッシュボードの履歴に戻ったら、
 *   openDashboard でそのダッシュボードを開く（範囲は、開くときに URL から読む）
 * - 印の無い履歴（ほかの画面・アプリの外）は、何もしない
 * 戻り値は、登録を外す関数。
 */
export function followBrowserBack(openDashboard: (dashboardId: string) => void): () => void {
  const onPopState = (event: PopStateEvent) => {
    const dashboardId = dashboardOfMark(event.state);
    if (dashboardId === null) return;
    // このタブで書いた範囲なので、開くとき（initTimeRangeFromUrl）に固定の期間も使ってよい
    rememberUrlRange(window.location.search);
    if (dashboardId === openDashboardId) useTimeRangeStore.setState({ range: rangeInUrl() });
    else openDashboard(dashboardId);
  };
  window.addEventListener("popstate", onPopState);
  return () => window.removeEventListener("popstate", onPopState);
}

// タブで別のダッシュボードへ移るとき、今の範囲（固定の期間も含む）を次の画面へ引き継ぐための控え
let carriedRange: TimeRange | null = null;

/**
 * タブで別のダッシュボードへ移る直前に呼ぶ: 今の範囲を、次に開くダッシュボードでもそのまま使う。
 * （移ると画面が作り直され、閉じる側の resetTimeRange が URL の範囲を消すため、ここで控えておく）
 * 控えは、次の画面を開いた後に消す。すぐに消さないのは、開発時の StrictMode が「開く→閉じる→開く」と 2 回開くため
 */
export function keepTimeRangeForNextDashboard() {
  carriedRange = useTimeRangeStore.getState().range;
  setTimeout(() => {
    carriedRange = null;
  }, 0);
}

/**
 * ダッシュボードを開くとき: タブから移ったときは、前の画面の範囲をそのまま使う。
 * それ以外は、URL に範囲があればそれを使う。
 * ただし固定の期間（開始〜終了）は、このタブで書いたもの（再読み込み）だけを使う。ホーム画面のショートカットや
 * 新しいタブで開いた URL に残っていた固定の期間は、古い日時のままグラフが空になるので使わず、URL からも消す。
 * 無ければ、この端末で最後に見ていた範囲（localStorage）を使う。どちらも無ければ既定（直近 1 時間）。
 * 決めた範囲は、今の履歴の URL に書く（例: ?range=6h）。dashboardId は開くダッシュボードで、その印も付ける（出た後の「戻る」で帰れるように）。
 */
export function initTimeRangeFromUrl(dashboardId: string | null = null) {
  openDashboardId = dashboardId;
  if (carriedRange) {
    useTimeRangeStore.getState().setRange(carriedRange);
    return;
  }
  let fromUrl: TimeRange | null = null;
  try {
    fromUrl = fromSearchParams(window.location.search);
    if (fromUrl?.mode === "absolute" && !writtenInThisTab()) {
      fromUrl = null;
      clearUrl();
    }
  } catch {
    fromUrl = null;
  }
  const range = fromUrl ?? readStoredRange() ?? DEFAULT_RANGE;
  useTimeRangeStore.setState({ range });
  // 開いたときの範囲も、今の履歴の URL に書く（印も付く）。書かないと、範囲を変えてから「戻る」で開いたときの履歴に戻ったとき、
  // URL に範囲が無く、変えた後の範囲（localStorage）を読んでしまう（例: 6 時間で開く → 24 時間 → 戻る で 24 時間のまま）
  writeUrl(range, "replace");
}

/** 今の URL の範囲が、このタブで書いたものか */
function writtenInThisTab(): boolean {
  try {
    return sessionStorage.getItem(SESSION_URL_KEY) === rangeQueryOf(window.location.search);
  } catch {
    return false;
  }
}

/**
 * ダッシュボードから、ほかの画面（設定・全体監視など）へ移る直前に呼ぶ: 範囲と印の無い履歴を 1 つ積む。
 * 今の履歴（出る直前の範囲と印）を残すので、ほかの画面で「戻る」を 1 回押すと、出る直前の範囲でダッシュボードへ帰る。
 * （ほかの画面は URL を変えず履歴も積まないので、積まないと「戻る」でアプリの外へ出たり、1 つ前の範囲へ帰ったりする）
 * タブでの切り替え・キオスクの自動切り替え・「戻る」で移るときは呼ばない（次のダッシュボードが今の履歴を書き換える・履歴が増え続けるため）。
 * ダッシュボードを開いていなければ、何もしない。
 */
export function leaveDashboardInHistory() {
  if (openDashboardId === null) return;
  try {
    const url = new URL(window.location.href);
    url.searchParams.delete("range");
    url.searchParams.delete("from");
    url.searchParams.delete("to");
    window.history.pushState(null, "", url.toString());
  } catch {
    // 履歴を触れない環境では、「戻る」でダッシュボードへ帰れないだけ
  }
}

/**
 * ダッシュボードを閉じるとき: 画面の状態は既定に戻し、URL の範囲と印も消す。
 * localStorage の値は消さない（次に開いたとき、そこから復元するため）。
 * ただし「戻る」で別のダッシュボードの履歴に移って閉じるときは、今の履歴（移った先のもの）を消さない
 * （次に開くダッシュボードが、その URL の範囲を読むため）。dashboardId は閉じるダッシュボード。
 */
export function resetTimeRange(dashboardId: string | null = null) {
  useTimeRangeStore.setState({ range: DEFAULT_RANGE });
  if (openDashboardId === dashboardId) openDashboardId = null;
  const current = dashboardOfMark(window.history.state);
  if (current === null || current === dashboardId) clearUrl();
}
