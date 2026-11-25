/**
 * 計器グラフ（TrendStackWidget）のマウスでの時間の操作。2 つのフックに分けている。
 *
 * - useSelectZoom（グラフの枠に付ける）: 動かす・触れるとカーソルの時刻を動かす（指でも）。マウスでは
 *   押したまま横に動かして範囲を選び（水色の帯）、離すとその範囲に拡大。ダブルクリックで 2 倍に縮小。
 *   Ctrl（⌘）＋ホイールで、マウスの位置を中心に拡大・縮小（行を並べた枠に付ける wheelRef）
 * - useAxisPan（下の時刻の軸に付ける）: マウスで横にドラッグすると左右に移動。ドラッグ中は線を横にずらして
 *   見せるだけで（shiftPx）、範囲は変えない。離したときに 1 回だけ範囲を変えて取り直す
 *   （ドラッグ中に範囲を変えると、画面の全グラフが何度も取り直し、ラズパイの DB が詰まるため）
 *
 * 範囲はダッシュボードの期間（useTimeRangeStore）を変え、ブラウザの履歴に積む（「戻る」で前の範囲に戻れる）。
 * 指の端末（pointerType が mouse 以外）は、カーソルを動かすだけ。
 *
 * 【誰が使うか】TrendStackWidget。
 * 【引数】range = 計器グラフの今の範囲、bounds = その開始・終了（ミリ秒）、now = 今の時刻、
 *   widgetId = カーソルを動かしたグラフの ID、canChangeRange = ダッシュボードの期間を変えてよいか
 *   （ウィジェット固有の期間・リンクの一覧の中では false。カーソルだけ動く）。
 */
import { useMemo, useRef, useState, type MouseEvent, type PointerEvent } from "react";

import { absoluteRange, axisDragRange, maxRangeForBuild, resolveRange, zoomAround, type ResolvedRange, type TimeRange } from "../lib/timeRange";
import { GRAPH_BUCKETS } from "../components/widgets/graph-parts";
import { requestCursorTime } from "../store/useCursorTimeStore";
import { setRangeByWheel, useTimeRangeStore } from "../store/useTimeRangeStore";
import { useCursorZoom } from "./useCursorZoom";

/** これより短いドラッグ（px）は、範囲の選択にしない（ただのクリック・手ぶれとして扱う） */
const MIN_SELECT_PX = 6;
/** ドラッグで拡大した直後、これより早いダブルクリックは無視する（拡大の直後のクリックを、縮小と取り違えないため） */
const DOUBLE_CLICK_GUARD_MS = 500;

interface ZoomInput {
  range: TimeRange;
  bounds: ResolvedRange;
  now: number;
  widgetId: string;
  canChangeRange: boolean;
}

/** グラフの枠の操作 */
export interface PlotPointerHandlers {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
  onPointerLeave: () => void;
  onDoubleClick: (event: MouseEvent<HTMLDivElement>) => void;
}

/** 時刻の軸の操作 */
export interface AxisPointerHandlers {
  onPointerDown: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerMove: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerUp: (event: PointerEvent<HTMLDivElement>) => void;
  onPointerCancel: () => void;
  onLostPointerCapture: () => void;
}

/** ポインターの位置（clientX）の時刻。枠の外は端の時刻にする。枠の幅が分からないときは null */
function timeAtPointer(clientX: number, element: HTMLElement, bounds: ResolvedRange): number | null {
  const box = element.getBoundingClientRect();
  if (box.width <= 0) return null;
  const ratio = Math.min(1, Math.max(0, (clientX - box.left) / box.width));
  return bounds.from + ratio * (bounds.to - bounds.from);
}

/** マウスの左ボタンで押したか（指・ペン・右クリックでは、範囲を変えない） */
function isMouseLeftPress(event: PointerEvent<HTMLDivElement>): boolean {
  return event.pointerType === "mouse" && event.button === 0;
}

/** ポインターを、離すまでこの要素で受ける（枠の外で離しても、離したことが分かるように）。使えない環境では何もしない */
function capturePointer(event: PointerEvent<HTMLDivElement>) {
  const target = event.currentTarget;
  if (typeof target.setPointerCapture === "function") target.setPointerCapture(event.pointerId);
}

/**
 * グラフの枠の操作（カーソル・範囲の選択・ダブルクリック・ホイール）。
 * 返すもの: pointer（グラフの枠に付ける）、wheelRef（行を並べた枠に付ける）、selection（選んでいる範囲。帯で出す。無ければ null）
 */
export function useSelectZoom({ range, bounds, now, widgetId, canChangeRange }: ZoomInput) {
  const pushRange = useTimeRangeStore((s) => s.pushRange);
  const [selection, setSelection] = useState<ResolvedRange | null>(null);
  // 押した位置と時刻（範囲の選択の始まり）。マウスの左ボタンで押したときだけ
  const dragStart = useRef<{ clientX: number; time: number } | null>(null);
  // マウスが今ある位置の時刻（ホイールの拡大・縮小の中心）。グラフの外では null
  const hoverTime = useRef<number | null>(null);
  // 最後に押したのがマウスか（指のダブルタップで縮小しないため）
  const lastWasMouse = useRef(false);
  // ドラッグで拡大した時刻（その直後のダブルクリックを無視するため）
  const selectZoomedAt = useRef(0);

  // 行（TrendRow）に渡すので、範囲が変わらないかぎり同じ関数を使い続ける
  const pointer = useMemo<PlotPointerHandlers>(() => {
    // 動かした位置を、共有のカーソルの時刻にする（グラフの 1 区間に丸め、描画 1 回にまとめる）。
    // マウスが外れても、指を離しても、カーソルはその位置に残す（勝手に今へ戻さない。戻すのは「今に戻す」）
    const moveCursor = (event: PointerEvent<HTMLDivElement>): number | null => {
      const time = timeAtPointer(event.clientX, event.currentTarget, bounds);
      if (time !== null) requestCursorTime(time, (bounds.to - bounds.from) / GRAPH_BUCKETS, widgetId);
      return time;
    };
    const cancelSelect = () => {
      dragStart.current = null;
      setSelection(null);
    };
    return {
      onPointerDown: (event) => {
        const time = moveCursor(event);
        lastWasMouse.current = event.pointerType === "mouse";
        if (!canChangeRange || !isMouseLeftPress(event) || time === null) return;
        dragStart.current = { clientX: event.clientX, time };
        capturePointer(event);
      },
      onPointerMove: (event) => {
        const time = moveCursor(event);
        if (event.pointerType === "mouse") hoverTime.current = time;
        const start = dragStart.current;
        if (!start) return;
        // ボタンが離れている（離したことが届かなかった）なら、選択をやめる
        if (event.buttons === 0) return cancelSelect();
        if (time === null || Math.abs(event.clientX - start.clientX) < MIN_SELECT_PX) return;
        setSelection({ from: Math.min(start.time, time), to: Math.max(start.time, time) });
      },
      onPointerUp: (event) => {
        const start = dragStart.current;
        cancelSelect();
        if (!start || Math.abs(event.clientX - start.clientX) < MIN_SELECT_PX) return;
        const end = timeAtPointer(event.clientX, event.currentTarget, bounds);
        const next = end === null ? null : absoluteRange(Math.min(start.time, end), Math.max(start.time, end));
        if (!next) return;
        selectZoomedAt.current = Date.now();
        pushRange(next);
      },
      onPointerCancel: cancelSelect,
      onLostPointerCapture: cancelSelect,
      onPointerLeave: () => {
        hoverTime.current = null;
      },
      onDoubleClick: (event) => {
        if (!canChangeRange || !lastWasMouse.current) return;
        if (Date.now() - selectZoomedAt.current < DOUBLE_CLICK_GUARD_MS) return;
        const anchor = timeAtPointer(event.clientX, event.currentTarget, bounds);
        if (anchor !== null) pushRange(zoomAround(range, anchor, 2, now, maxRangeForBuild()));
      },
    };
  }, [bounds, widgetId, canChangeRange, range, now, pushRange]);

  // Ctrl（⌘）＋ホイールで、マウスの位置を中心に拡大・縮小する（続けて回している間は、履歴を 1 つにまとめる）
  const wheelRef = useCursorZoom(
    () => (canChangeRange ? hoverTime.current : null),
    (anchor, factor) => setRangeByWheel(zoomAround(range, anchor, factor, now, maxRangeForBuild())),
  );

  return { pointer, wheelRef, selection };
}

/** 時刻の軸のドラッグを始めたときの様子 */
interface AxisDrag {
  /** 押した位置（px） */
  clientX: number;
  /** 軸の幅（px）。動かした px を時間に直すのに使う */
  width: number;
  /** 押したときの表示範囲 */
  start: ResolvedRange;
  /** 押したとき直近の表示（右端が今）だったか */
  live: boolean;
}

/**
 * 時刻の軸のドラッグで、左右に移動する。
 * 返すもの: axisPointer（時刻の軸に付ける）、shiftPx（ドラッグ中に線・目盛りを横にずらす px。ドラッグしていなければ 0）
 */
export function useAxisPan({ range, bounds, now, canChangeRange }: Omit<ZoomInput, "widgetId">) {
  const pushRange = useTimeRangeStore((s) => s.pushRange);
  const drag = useRef<AxisDrag | null>(null);
  const [shiftPx, setShiftPx] = useState(0);

  const axisPointer = useMemo<AxisPointerHandlers>(() => {
    /** 押した位置から clientX まで動かしたときの範囲（今より先へは行かない） */
    const rangeAt = (current: AxisDrag, clientX: number) =>
      axisDragRange(current.start, current.live, clientX - current.clientX, current.width, now, maxRangeForBuild());
    const stop = () => {
      drag.current = null;
      setShiftPx(0);
    };
    return {
      onPointerDown: (event) => {
        if (!canChangeRange || !isMouseLeftPress(event)) return;
        const width = event.currentTarget.getBoundingClientRect().width;
        if (width <= 0) return;
        drag.current = { clientX: event.clientX, width, start: bounds, live: range.mode === "relative" };
        capturePointer(event);
      },
      onPointerMove: (event) => {
        const current = drag.current;
        if (!current) return;
        if (event.buttons === 0) return stop();
        // 範囲は変えず、動かした先の範囲の位置まで、今の線を横にずらして見せる（今より先へは、ずらさない）
        const next = resolveRange(rangeAt(current, event.clientX), now);
        setShiftPx(((current.start.from - next.from) / (current.start.to - current.start.from)) * current.width);
      },
      onPointerUp: (event) => {
        const current = drag.current;
        stop();
        if (!current || event.clientX === current.clientX) return;
        // 離したときに 1 回だけ範囲を変える（取り直しも 1 回）
        pushRange(rangeAt(current, event.clientX));
      },
      onPointerCancel: stop,
      onLostPointerCapture: stop,
    };
  }, [bounds, canChangeRange, range, now, pushRange]);

  return { axisPointer, shiftPx };
}
