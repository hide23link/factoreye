/**
 * 動かせる窓（センサー棚・設定パネル）の、見出しの操作をまとめたフック。
 *
 * - 見出しをつかんで動かす（ポインター）。つかんだポインター以外の動きは無視する。動かし終えた（離した・取り消された）ときに 1 回保存する
 * - 見出しにフォーカスして矢印キーで動かす（1 回 16px、Shift で 64px）
 * - 位置は画面内に制限する。640px 未満は、動かさない（従来の下寄せの固定）
 * - 「もとの位置」ボタンで、保存した位置を捨てて、既定の場所（自動配置）に戻す
 *
 * 【誰が使うか】EditorShelf（センサー棚の見出し）、WidgetSettings・SettingsPanel（設定パネルの見出し）。
 * 【引数】kind = どの窓か、label = 見出しの読み上げ名（例: センサー棚）。
 */
import { useRef, type KeyboardEvent, type PointerEvent, type ReactNode } from "react";

import { NARROW_VIEWPORT } from "../lib/panel-placement";
import { clampWindowPosition, type MovableWindow, type WindowPosition } from "../lib/window-position";
import { useEditorStore } from "../store/useEditorStore";

// 矢印キー 1 回で動く量（px）。Shift を押しながらだと大きく動く
const KEY_STEP = 16;
const KEY_STEP_LARGE = 64;

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
} {
  const pos = useEditorStore((s) => (kind === "shelf" ? s.shelfPos : s.panelPos));
  const setPos = (next: WindowPosition | null, options?: { persist?: boolean }) => {
    const store = useEditorStore.getState();
    if (kind === "shelf") store.setShelfPos(next, options);
    else store.setPanelPos(next, options);
  };
  const currentPos = () => (kind === "shelf" ? useEditorStore.getState().shelfPos : useEditorStore.getState().panelPos);
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
  const clampToViewport = (p: WindowPosition) => clampWindowPosition(kind, p, window.innerWidth, window.innerHeight);

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

  // 動かした後だけ出す。押すと、保存を消して既定の場所（自動配置）に戻る
  const resetButton = pos ? (
    <button
      type="button"
      aria-label={`${label}の位置をもとに戻す`}
      title="位置をもとに戻す"
      onClick={() => setPos(null)}
      className="h-6 shrink-0 rounded px-1.5 text-xs text-gray-600 hover:bg-gray-100"
    >
      ⟲ もとの位置
    </button>
  ) : null;

  return { pos, handleProps, resetButton };
}
