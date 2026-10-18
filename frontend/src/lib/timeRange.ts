/**
 * グラフの表示時間範囲（Grafana のような操作）の計算と、URL との相互変換。
 *
 * - relative（直近モード）: 右端は常に現在時刻。duration は表示の幅（ミリ秒）
 * - absolute（固定モード）: 開始と終了を指定した期間。更新しても動かない
 *
 * 画面（React）に依存しない純粋な関数だけを置く。テストしやすくするため。
 *
 * 【誰が使うか】useTimeRangeStore.ts、TimeRangeControls.tsx、グラフ系の2つのウィジェット。
 */

export type TimeRange =
  | { mode: "relative"; durationMs: number }
  | { mode: "absolute"; from: number; to: number };

export interface ResolvedRange {
  from: number;
  to: number;
}

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** プリセットの範囲（短い順）。表示のラベルと、URL での表記（range=…）を兼ねる */
export const PRESETS: ReadonlyArray<{ key: string; label: string; durationMs: number }> = [
  { key: "5m", label: "直近 5 分", durationMs: 5 * MINUTE },
  { key: "15m", label: "直近 15 分", durationMs: 15 * MINUTE },
  { key: "1h", label: "直近 1 時間", durationMs: HOUR },
  { key: "6h", label: "直近 6 時間", durationMs: 6 * HOUR },
  { key: "24h", label: "直近 24 時間", durationMs: DAY },
  { key: "7d", label: "直近 7 日", durationMs: 7 * DAY },
  { key: "30d", label: "直近 30 日", durationMs: 30 * DAY },
];

/** 既定の表示範囲（直近 1 時間）。ダッシュボードを開いたときの初期値 */
export const DEFAULT_RANGE: TimeRange = { mode: "relative", durationMs: HOUR };

/** 1 回の移動・拡大縮小の最小幅（これより狭くしない） */
const MIN_DURATION_MS = MINUTE;

/**
 * 表示できる最長の期間。SaaS（Free Tier）は測定値の保持が 90 日のため 90 日まで。
 * self-hosted は保持期間の制限が無いので、上限を設けない。
 */
export function maxRangeMs(isMultiTenant: boolean): number {
  return isMultiTenant ? 90 * DAY : Number.POSITIVE_INFINITY;
}

/** このビルド（VITE_AUTH_MODE）での、表示できる最長の期間 */
export function maxRangeForBuild(): number {
  return maxRangeMs(import.meta.env.VITE_AUTH_MODE === "multi_tenant");
}

/** 範囲を、今の時刻を基準に、開始と終了（ミリ秒）に直す */
export function resolveRange(range: TimeRange, now: number): ResolvedRange {
  if (range.mode === "relative") {
    return { from: now - range.durationMs, to: now };
  }
  return { from: range.from, to: range.to };
}

/** 固定の期間を作る。開始が終了より後、または幅が 0 のときは null */
export function absoluteRange(from: number, to: number): TimeRange | null {
  if (!Number.isFinite(from) || !Number.isFinite(to) || to <= from) return null;
  return { mode: "absolute", from, to };
}

/** 範囲の幅（ミリ秒） */
function spanOf(range: TimeRange, now: number): number {
  const { from, to } = resolveRange(range, now);
  return to - from;
}

/**
 * 範囲を、幅の分だけ過去（direction = -1）または未来（direction = 1）へ動かす。
 * 動かすと固定モードになる（右端が今を越えないように、未来方向は現在で止める）。
 */
export function panRange(range: TimeRange, direction: -1 | 1, now: number, maxMs: number): TimeRange {
  const { from, to } = resolveRange(range, now);
  const span = to - from;
  let nextTo = to + direction * span;
  // 未来へは、現在時刻より先に行かない
  if (nextTo > now) nextTo = now;
  const nextFrom = nextTo - span;
  return clampToMax({ mode: "absolute", from: nextFrom, to: nextTo }, maxMs);
}

/**
 * 範囲の幅を factor 倍にする（0.5 で縮小、2 で拡大）。
 * 直近モードは右端を今のまま保つ（幅だけ変える）。固定モードは中心を保つ。
 */
export function zoomRange(range: TimeRange, factor: number, now: number, maxMs: number): TimeRange {
  const span = clampSpan(spanOf(range, now) * factor, maxMs);
  if (range.mode === "relative") {
    return { mode: "relative", durationMs: span };
  }
  const center = (range.from + range.to) / 2;
  let to = center + span / 2;
  let from = center - span / 2;
  // 右端が今を越えないように、現在時刻まで寄せる（未来のデータは無いため）
  if (to > now) {
    from -= to - now;
    to = now;
  }
  return clampToMax({ mode: "absolute", from, to }, maxMs);
}

/**
 * カーソルの位置（anchor の時刻）を動かさずに、幅を factor 倍にする。
 * Grafana の「カーソル位置を中心に拡大・縮小」と同じ。anchor が範囲の左寄りなら左側が、
 * 右寄りなら右側が大きく変わる（anchor から見た左右の比率を保つ）。
 * 右端が今を越えるときは、今まで寄せる。固定モードになる。
 */
export function zoomAround(
  range: TimeRange,
  anchor: number,
  factor: number,
  now: number,
  maxMs: number,
): TimeRange {
  const { from, to } = resolveRange(range, now);
  const span = clampSpan((to - from) * factor, maxMs);
  // anchor より左の割合（0〜1）を保つ。範囲の外にある anchor でも、比率のまま計算する
  const ratio = (anchor - from) / (to - from);
  let nextFrom = anchor - ratio * span;
  let nextTo = nextFrom + span;
  if (nextTo > now) {
    nextFrom -= nextTo - now;
    nextTo = now;
  }
  return clampToMax({ mode: "absolute", from: nextFrom, to: nextTo }, maxMs);
}

/** 「今に戻る」: 幅はそのままで、右端を現在時刻にした直近モードにする */
export function nowRange(range: TimeRange, now: number): TimeRange {
  return { mode: "relative", durationMs: spanOf(range, now) };
}

/** 範囲の幅を、上限と下限の中に収める */
function clampSpan(span: number, maxMs: number): number {
  return Math.min(Math.max(span, MIN_DURATION_MS), maxMs);
}

/** 固定の範囲が上限を超えたら、終了はそのままに開始を縮める */
function clampToMax(range: TimeRange, maxMs: number): TimeRange {
  if (range.mode !== "absolute") return range;
  const span = range.to - range.from;
  if (span <= maxMs) return range;
  return { mode: "absolute", from: range.to - maxMs, to: range.to };
}

/** 範囲を、URL のクエリ（?range=1h または ?from=…&to=…）に直す。直近は今の時刻に依らない表記 */
export function toSearchParams(range: TimeRange): URLSearchParams {
  const params = new URLSearchParams();
  if (range.mode === "relative") {
    const preset = PRESETS.find((p) => p.durationMs === range.durationMs);
    params.set("range", preset ? preset.key : `${Math.round(range.durationMs / MINUTE)}m`);
    return params;
  }
  params.set("from", new Date(range.from).toISOString());
  params.set("to", new Date(range.to).toISOString());
  return params;
}

/**
 * URL のクエリから範囲を読む。読めない・おかしい値は null（呼び出し側で既定にする）。
 * range は PRESETS の key（例: 1h）か、「数字 + m/h/d」（例: 90m）。
 */
export function fromSearchParams(search: string): TimeRange | null {
  const params = new URLSearchParams(search);
  const rangeKey = params.get("range");
  if (rangeKey) {
    const durationMs = parseDuration(rangeKey);
    return durationMs === null ? null : { mode: "relative", durationMs };
  }
  const fromText = params.get("from");
  const toText = params.get("to");
  if (fromText && toText) {
    return absoluteRange(Date.parse(fromText), Date.parse(toText));
  }
  return null;
}

function parseDuration(key: string): number | null {
  const preset = PRESETS.find((p) => p.key === key);
  if (preset) return preset.durationMs;
  const match = /^(\d+)([mhd])$/.exec(key);
  if (!match) return null;
  const value = Number(match[1]);
  if (value <= 0) return null;
  const unit = match[2] === "m" ? MINUTE : match[2] === "h" ? HOUR : DAY;
  return value * unit;
}

/** 範囲の説明（画面の表示用）。直近は「直近 1 時間」、固定は開始と終了の時刻 */
export function describeRange(range: TimeRange): string {
  if (range.mode === "relative") {
    const preset = PRESETS.find((p) => p.durationMs === range.durationMs);
    return preset ? preset.label : `直近 ${Math.round(range.durationMs / MINUTE)} 分`;
  }
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("ja-JP", {
      month: "numeric",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(range.from)} 〜 ${fmt(range.to)}`;
}

/** 表示の幅（時間）。グラフの横軸の書式（時刻だけ・日付も）を決めるのに使う */
export function spanHours(range: TimeRange, now: number): number {
  return spanOf(range, now) / HOUR;
}
