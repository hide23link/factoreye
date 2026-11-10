/**
 * リンクの画面（グラフ 1 つを 1 画面で見る）の、期間の計算と表示の文字。
 *
 * 期間は { durationMs: 長さ, endMs: 右端の時刻 } で持つ。endMs が null のときは「今」を見ている（自動で更新する）。
 * 指で変えた期間は、この画面の中だけで持ち、localStorage にも URL にも書かない（ダッシュボードの期間とは別）。
 *
 * 画面（React）に依存しない関数だけを置く（テストしやすくするため）。
 *
 * 【誰が使うか】GraphLinkView（指の操作・期間のボタン・時刻の指定）。
 */

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/** 拡大・縮小の下限・上限。上限は 7 日（ただし、表示できる最長 maxRangeForBuild を超えない） */
export const LINK_VIEW_MIN_MS = 10 * MINUTE;
export const LINK_VIEW_MAX_MS = 7 * DAY;
/** 過去へ動かせる限り（今から 30 日前まで） */
const PAST_LIMIT_MS = 30 * DAY;

/** 下の期間のボタン（分）: 30 分・1・3・8・24 時間 */
export const LINK_CHIPS_MINUTES = [30, 60, 180, 480, 1440] as const;

/** 画面の期間。endMs = null は「今」（右端が今で、自動で更新する） */
export interface LinkPeriod {
  durationMs: number;
  endMs: number | null;
}

/** 範囲の開始と終了（ミリ秒） */
export function periodBounds(period: LinkPeriod, now: number): { from: number; to: number } {
  const to = period.endMs ?? now;
  return { from: to - period.durationMs, to };
}

/** 長さを、下限〜上限に収める */
function clampDuration(durationMs: number, maxMs: number): number {
  return Math.min(Math.max(durationMs, LINK_VIEW_MIN_MS), Math.min(LINK_VIEW_MAX_MS, maxMs));
}

/** 右端を、30 日前〜今に収める。今に届いたら「今」（null）にする */
function clampEnd(endMs: number, now: number): number | null {
  if (endMs >= now) return null;
  return Math.max(endMs, now - PAST_LIMIT_MS);
}

/**
 * 長さを変える（上下スワイプ・ピンチ・ホイール）。anchor は、動かさない位置（0 = 左端、1 = 右端）。
 * 今を見ているときに anchor = 1 なら、右端は今のまま。
 */
export function zoomPeriod(period: LinkPeriod, durationMs: number, anchor: number, now: number, maxMs: number): LinkPeriod {
  const nextDuration = clampDuration(durationMs, maxMs);
  const end = period.endMs ?? now;
  // anchor の時刻を保ったまま、長さだけを変える
  const anchorTime = end - period.durationMs * (1 - anchor);
  const nextEnd = anchorTime + nextDuration * (1 - anchor);
  return { durationMs: nextDuration, endMs: clampEnd(nextEnd, now) };
}

/**
 * 上下スワイプの長さ。上へ（dy < 0）なぞると短く（拡大）、下へなぞると長くする（縮小）。
 * なぞり始めの期間から計算する（なぞる途中で計算を重ねない）。今を見ているときは右端（今）を保つ。
 */
export function swipeZoom(start: LinkPeriod, dy: number, now: number, maxMs: number): LinkPeriod {
  // 140px なぞると、長さが約 2.7 倍（e 倍）になる（モックで確かめた速さ）
  const factor = Math.exp(dy / 140);
  return zoomPeriod(start, start.durationMs * factor, start.endMs === null ? 1 : 0.5, now, maxMs);
}

/** ピンチ: 指の間が広がると短く（拡大）、狭まると長くする。真ん中を保つ */
export function pinchZoom(start: LinkPeriod, startDistance: number, distance: number, now: number, maxMs: number): LinkPeriod {
  const ratio = Math.max(startDistance, 1) / Math.max(distance, 1);
  return zoomPeriod(start, start.durationMs * ratio, 0.5, now, maxMs);
}

/**
 * 左右ドラッグ: 時間を動かす。右へなぞる（dx > 0）と過去へ。長さは変えない。今より先には行かない。
 * width はグラフの横幅（px）。なぞった幅の割合だけ動かす。
 */
export function panPeriod(start: LinkPeriod, dx: number, width: number, now: number): LinkPeriod {
  const end = start.endMs ?? now;
  const shift = (dx / Math.max(width, 1)) * start.durationMs;
  return { durationMs: start.durationMs, endMs: clampEnd(end - shift, now) };
}

/** 期間のボタン: 長さだけを変える（今を見ているときは今のまま、過去なら右端のまま） */
export function chipPeriod(period: LinkPeriod, minutes: number, now: number, maxMs: number): LinkPeriod {
  const durationMs = clampDuration(minutes * MINUTE, maxMs);
  return { durationMs, endMs: period.endMs === null ? null : clampEnd(period.endMs, now) };
}

/** 時刻の指定: その時刻から（長さは今のまま）。未来の時刻なら null（呼ぶ側が「まだ来ていない時刻です」を出す） */
export function startAtPeriod(period: LinkPeriod, startMs: number, now: number): LinkPeriod | null {
  if (!Number.isFinite(startMs) || startMs >= now) return null;
  return { durationMs: period.durationMs, endMs: clampEnd(startMs + period.durationMs, now) };
}

/** リンクの設定（直近 N 分・今） */
export function linkPeriod(rangeMinutes: number): LinkPeriod {
  return { durationMs: rangeMinutes * MINUTE, endMs: null };
}

/** リンクの設定のままか（「今に戻る」を出さないため） */
export function isAtLink(period: LinkPeriod, rangeMinutes: number): boolean {
  return period.endMs === null && Math.abs(period.durationMs - rangeMinutes * MINUTE) < MINUTE;
}

/** 期間のボタンが今の長さと同じか */
export function isChipActive(period: LinkPeriod, minutes: number): boolean {
  return Math.abs(period.durationMs - minutes * MINUTE) < MINUTE;
}

// ── 表示の文字 ───────────────────────────────────────

/** 時刻を「8:05」の形にする（端末の時刻） */
export function clockText(ms: number): string {
  const date = new Date(ms);
  return `${date.getHours()}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** 長さを「30 分」「1.5 時間」「2 日」の形にする */
export function durationText(ms: number): string {
  const minutes = Math.round(ms / MINUTE);
  if (minutes < 60) return `${minutes} 分`;
  const oneDecimal = (value: number) => String(Math.round(value * 10) / 10);
  if (minutes < 1440) return `${oneDecimal(minutes / 60)} 時間`;
  return `${oneDecimal(minutes / 1440)} 日`;
}

/** 期間のボタンの文字（「30 分」「3 時間」） */
export function chipText(minutes: number): string {
  return minutes < 60 ? `${minutes} 分` : `${minutes / 60} 時間`;
}

/** 上の期間の表示。今なら「直近 30 分」、過去なら「8:00〜8:30」 */
export function periodLabel(period: LinkPeriod, now: number): string {
  if (period.endMs === null) return `直近 ${durationText(period.durationMs)}`;
  const { from, to } = periodBounds(period, now);
  return `${clockText(from)}〜${clockText(to)}`;
}

/** 下の状態の行。今なら「11:30 更新・自動で更新中」、過去なら「2 時間前まで・更新を止めています」 */
export function statusText(period: LinkPeriod, now: number, updatedAt: number): string {
  if (period.endMs === null) return `${clockText(updatedAt)} 更新・自動で更新中`;
  return `${durationText(now - period.endMs)}前まで・更新を止めています`;
}

// ── 時刻の指定（<input type="datetime-local">）────────────────

/** 時刻を、datetime-local の値（「2026-11-10T08:00」端末の時刻）にする */
export function toLocalInput(ms: number): string {
  const d = new Date(ms);
  const two = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}T${two(d.getHours())}:${two(d.getMinutes())}`;
}

/** datetime-local の値を時刻（ミリ秒）にする。読めなければ null */
export function fromLocalInput(text: string): number | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(text);
  if (!match) return null;
  const [year, month, day, hour, minute] = match.slice(1).map(Number);
  return new Date(year, month - 1, day, hour, minute).getTime();
}

/** 5 分刻みに切り下げる（時刻の指定の初期値。入力欄の step=300 と合わせる） */
export function floorToFiveMinutes(ms: number): number {
  return Math.floor(ms / (5 * MINUTE)) * 5 * MINUTE;
}

/** 時刻の指定の近道: 今日 8:00・今日 13:00・昨日 8:00（端末の日付） */
export function quickStarts(now: number): { label: string; value: string }[] {
  const at = (daysAgo: number, hour: number) => {
    const d = new Date(now);
    d.setDate(d.getDate() - daysAgo);
    d.setHours(hour, 0, 0, 0);
    return toLocalInput(d.getTime());
  };
  return [
    { label: "今日 8:00", value: at(0, 8) },
    { label: "今日 13:00", value: at(0, 13) },
    { label: "昨日 8:00", value: at(1, 8) },
  ];
}

/** 時刻の指定で選べる最も古い時刻（今から 30 日前） */
export function earliestStart(now: number): number {
  return now - PAST_LIMIT_MS;
}
