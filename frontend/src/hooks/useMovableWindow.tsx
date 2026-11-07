/**
 * 動かせる窓（センサー棚・設定パネル）の、見出しと大きさのつかみ部分の操作をまとめたフック。
 *
 * - 見出しをつかんで動かす（ポインター）。つかんだポインター以外の動きは無視する。動かし終えた（離した・取り消された）ときに 1 回保存する
 * - 見出しにフォーカスして矢印キーで動かす（1 回 16px、Shift で 64px）
 * - 位置は画面内に制限する。640px 未満は、動かさない（従来の下寄せの固定）
 * - 窓の右辺・下辺・右下のつかみ部分をドラッグすると、幅・高さが変わる。つかみ部分にフォーカスして矢印キーでも変えられる
 *   （右辺は左右、下辺は上下、右下は両方。見出しの移動と同じく 16px、Shift で 64px）。大きさは最小〜画面内に収まる範囲に制限する。
 *   既定の場所の窓を初めて変えたときは、そのときの位置・大きさを実測して、動かした窓と同じ扱いにする
 * - 「もとの位置・大きさ」ボタンで、保存した位置と大きさを捨てて、既定の場所・大きさ（自動配置）に戻す
 *
 * 【誰が使うか】EditorShelf（センサー棚）、WidgetSettings・SettingsPanel（設定パネル）。
 * 【引数】kind = どの窓か、label = 読み上げ名（例: センサー棚）。
 * 【戻り値】handleProps = 見出しに付ける、resetButton = 見出しに置くボタン、resizeHandles = 窓の中（最後）に置く、大きさのつかみ部分。
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { NARROW_VIEWPORT } from "../lib/panel-placement";
import {
  MIN_WINDOW_HEIGHT,
  WINDOW_WIDTH,
  clampWindowPosition,
  clampWindowSize,
  type MovableWindow,
  type WindowPosition,
  type WindowSize,
} from "../lib/window-position";
import { useEditorStore } from "../store/useEditorStore";

// 矢印キー 1 回で動く量（px）。Shift を押しながらだと大きく動く
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

/** 大きさを変える向き: 右辺（幅）・下辺（高さ）・右下（両方） */
type ResizeAxis = "x" | "y" | "both";

const RESIZE_HANDLES: ReadonlyArray<{ axis: ResizeAxis; name: string; hint: string; className: string }> = [
  { axis: "x", name: "right", hint: "幅", className: "absolute right-0 top-0 h-full w-1.5 cursor-ew-resize" },
  { axis: "y", name: "bottom", hint: "高さ", className: "absolute bottom-0 left-0 h-1.5 w-full cursor-ns-resize" },
  { axis: "both", name: "corner", hint: "幅と高さ", className: "absolute bottom-0 right-0 z-10 h-4 w-4 cursor-nwse-resize" },
];

export function useMovableWindow(kind: MovableWindow, label: string): {
  pos: WindowPosition | null;
  handleProps: {
    role: "group";
    tabIndex: 0;
    "aria-label": string;
    "data-testid": string;
    onPointerDown: (e: PointerEvent<HTMLElement>) => void;
    onPointerMove: (e: PointerEvent<HTMLElement>) => void;
    onPointerUp: (e: PointerEvent<HTMLElement>) => void;
    onPointerCancel: (e: PointerEvent<HTMLElement>) => void;
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => void;
  };
  resetButton: ReactNode;
  resizeHandles: ReactNode;
} {
  const pos = useEditorStore((s) => (kind === "shelf" ? s.shelfPos : s.panelPos));
  const setPos = (next: WindowPosition | null, options?: { persist?: boolean }) => {
    const store = useEditorStore.getState();
    if (kind === "shelf") store.setShelfPos(next, options);
    else store.setPanelPos(next, options);
  };
  const currentPos = () => (kind === "shelf" ? useEditorStore.getState().shelfPos : useEditorStore.getState().panelPos);
  const setSize = (next: WindowSize | null, options?: { persist?: boolean }) => {
    const store = useEditorStore.getState();
    if (kind === "shelf") store.setShelfSize(next, options);
    else store.setPanelSize(next, options);
  };
  const currentSize = () => (kind === "shelf" ? useEditorStore.getState().shelfSize : useEditorStore.getState().panelSize);
  // 大きさを変えている途中の状態（つかんだポインターと、向き・つかんだ位置・そのときの大きさ）
  const resize = useRef<{ pointerId: number; axis: ResizeAxis; startX: number; startY: number; width: number; height: number } | null>(null);
  // 移動の途中の状態（つかんだポインターと、つかんだ位置・そのときの窓の位置）
  const drag = useRef<{ pointerId: number; startX: number; startY: number; originX: number; originY: number } | null>(null);

  const movable = () => window.innerWidth >= NARROW_VIEWPORT;
  /** いまの窓の位置（動かしたことが無ければ、既定の場所の実測値） */
  const currentOrigin = (header: HTMLElement): WindowPosition => {
    const stored = currentPos();
    if (stored) return stored;
    const box = header.closest("aside")?.getBoundingClientRect();
    return { x: box?.left ?? 8, y: box?.top ?? 0 };
  };
  // 大きさを変えた窓は、その幅で制限する（既定の幅で制限すると、右端へ動かしたときに窓が縮む）
  const clampToViewport = (p: WindowPosition) =>
    clampWindowPosition(kind, p, window.innerWidth, window.innerHeight, currentSize()?.width);

  /** いまの窓の位置と大きさ。動かした・大きさを変えたことが無ければ、画面に出ている実測値 */
  const currentBox = (handle: HTMLElement): { pos: WindowPosition; size: WindowSize } => {
    const box = handle.closest("aside")?.getBoundingClientRect();
    const pos = currentPos() ?? { x: box?.left ?? 8, y: box?.top ?? 0 };
    const size = currentSize() ?? { width: box?.width ?? WINDOW_WIDTH[kind], height: box?.height ?? MIN_WINDOW_HEIGHT };
    // 実測値も、最小〜最大の範囲に収める（測れない環境で 0 になっても、最小から始まる）
    return { pos, size: clampWindowSize(kind, size, pos, window.innerWidth, window.innerHeight) };
  };
  /** 窓の位置と大きさを決める（既定の場所の窓は、この時点で位置も固定する）。persist=false は途中 */
  const applyBox = (pos: WindowPosition, size: WindowSize, options?: { persist?: boolean }) => {
    setPos(pos, options);
    setSize(clampWindowSize(kind, size, pos, window.innerWidth, window.innerHeight), options);
  };
  const finishResize = (pointerId: number) => {
    if (!resize.current || resize.current.pointerId !== pointerId) return;
    resize.current = null;
    useEditorStore.getState().setShelfMoving(false);
    setPos(currentPos());
    setSize(currentSize());
  };

  /** 移動を終える。つかんだポインターのときだけ、位置を 1 回保存する */
  const finishDrag = (pointerId: number) => {
    const d = drag.current;
    if (!d || d.pointerId !== pointerId) return;
    drag.current = null;
    useEditorStore.getState().setShelfMoving(false);
    setPos(currentPos());
  };

  const handleProps = {
    role: "group" as const,
    tabIndex: 0 as const,
    "aria-label": `${label}の見出し（つかんで移動。矢印キーでも動かせます。Shift で大きく）`,
    "data-testid": `${kind}-handle`,
    onPointerDown: (e: PointerEvent<HTMLElement>) => {
      if (!movable() || e.button > 0 || (e.target as HTMLElement).closest("button")) return;
      const origin = currentOrigin(e.currentTarget);
      useEditorStore.getState().setShelfMoving(true);
      drag.current = { pointerId: e.pointerId, startX: e.clientX, startY: e.clientY, originX: origin.x, originY: origin.y };
      e.currentTarget.setPointerCapture?.(e.pointerId);
    },
    onPointerMove: (e: PointerEvent<HTMLElement>) => {
      const d = drag.current;
      // つかんだ指・ポインター以外（タッチの 2 本目の指など）の動きは無視する
      if (!d || e.pointerId !== d.pointerId) return;
      setPos(clampToViewport({ x: d.originX + e.clientX - d.startX, y: d.originY + e.clientY - d.startY }), { persist: false });
    },
    onPointerUp: (e: PointerEvent<HTMLElement>) => finishDrag(e.pointerId),
    // 取り消し（システムの割り込みなど）でも、動かし終えたときと同じに保存する
    onPointerCancel: (e: PointerEvent<HTMLElement>) => finishDrag(e.pointerId),
    onKeyDown: (e: KeyboardEvent<HTMLElement>) => {
      const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
      if (!delta || !movable() || e.target !== e.currentTarget) return;
      e.preventDefault();
      const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
      const origin = currentOrigin(e.currentTarget);
      setPos(clampToViewport({ x: origin.x + delta[0] * step, y: origin.y + delta[1] * step }));
    },
  };

  // 動かした・大きさを変えた後だけ出す。押すと、保存を消して既定の場所・大きさ（自動配置）に戻る
  const resetButton = pos ? (
    <button
      type="button"
      aria-label={`${label}の位置と大きさをもとに戻す`}
      title="位置と大きさをもとに戻す"
      onClick={() => setPos(null)}
      className="h-6 shrink-0 rounded px-1.5 text-xs text-gray-600 hover:bg-gray-100"
    >
      ⟲ もとの位置・大きさ
    </button>
  ) : null;

  // 大きさのつかみ部分。640px 未満は下寄せの固定なので、出さない
  const resizeHandles = movable()
    ? RESIZE_HANDLES.map(({ axis, name, hint, className }) => (
        <div
          key={name}
          role="group"
          tabIndex={0}
          aria-label={`${label}の${hint}を変える（つかんで大きさを変更。矢印キーでも変えられます。Shift で大きく）`}
          data-testid={`${kind}-resize-${name}`}
          className={`${className} touch-none ${axis === "both" ? "text-gray-400 hover:text-blue-600" : ""} focus-visible:bg-blue-200`}
          onPointerDown={(e) => {
            if (e.button > 0) return;
            const { pos: origin, size: originSize } = currentBox(e.currentTarget);
            applyBox(origin, originSize, { persist: false });
            useEditorStore.getState().setShelfMoving(true);
            resize.current = { pointerId: e.pointerId, axis, startX: e.clientX, startY: e.clientY, width: originSize.width, height: originSize.height };
            e.currentTarget.setPointerCapture?.(e.pointerId);
          }}
          onPointerMove={(e) => {
            const r = resize.current;
            if (!r || e.pointerId !== r.pointerId) return;
            const origin = currentPos();
            if (!origin) return;
            const width = r.axis === "y" ? r.width : r.width + e.clientX - r.startX;
            const height = r.axis === "x" ? r.height : r.height + e.clientY - r.startY;
            setSize(clampWindowSize(kind, { width, height }, origin, window.innerWidth, window.innerHeight), { persist: false });
          }}
          onPointerUp={(e) => finishResize(e.pointerId)}
          onPointerCancel={(e) => finishResize(e.pointerId)}
          onKeyDown={(e) => {
            const delta = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] }[e.key];
            if (!delta || e.target !== e.currentTarget) return;
            // 右辺は左右だけ、下辺は上下だけ（向きの合わない矢印は、何もしない）
            if ((axis === "x" && delta[0] === 0) || (axis === "y" && delta[1] === 0)) return;
            e.preventDefault();
            const step = e.shiftKey ? KEY_STEP_LARGE : KEY_STEP;
            const { pos: origin, size: originSize } = currentBox(e.currentTarget);
            applyBox(origin, { width: originSize.width + delta[0] * step, height: originSize.height + delta[1] * step });
          }}
        >
          {axis === "both" && (
            <svg aria-hidden="true" viewBox="0 0 16 16" className="h-4 w-4">
              <path d="M14 6 6 14M14 10l-4 4M14 2 2 14" stroke="currentColor" strokeWidth="1.2" fill="none" />
            </svg>
          )}
        </div>
      ))
    : null;

  return { pos, handleProps, resetButton, resizeHandles };
}
