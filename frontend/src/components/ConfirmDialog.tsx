/**
 * 「本当に実行しますか？」の確認の小窓（削除など、元に戻せない操作の前に出す）。
 * ブラウザ標準の confirm は使わず、画面の中で確認する。
 * キーボード: 開いたら「キャンセル」（安全側）にフォーカスし、Esc でキャンセル、Tab は小窓の中で循環する。
 * 閉じたら、開く前にフォーカスのあった要素へ戻す。背景のクリックでは閉じない。
 * ウィジェットの枠（react-grid-layout のグリッド）の中から呼ばれても画面全体に出るよう、document.body へ portal する。
 */
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "削除",
  onConfirm,
  onCancel,
  pending = false,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
  /** 実行中。true の間は、確認ボタンを押せない（二重実行を防ぐ） */
  pending?: boolean;
}) {
  const titleId = useId();
  const dialogRef = useRef<HTMLDivElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);

  // 開いたときにキャンセルへフォーカスし、閉じたとき（unmount）に元の要素へ戻す
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    cancelRef.current?.focus();
    return () => previous?.focus?.();
  }, []);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      onCancel();
      return;
    }
    if (e.key !== "Tab") return;
    // 小窓の中の押せるボタンだけで、Tab を循環させる
    const buttons = Array.from(
      dialogRef.current?.querySelectorAll<HTMLButtonElement>("button:not([disabled])") ?? [],
    );
    if (buttons.length === 0) return;
    const first = buttons[0];
    const last = buttons[buttons.length - 1];
    const active = document.activeElement;
    if (e.shiftKey && (active === first || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      last.focus();
    } else if (!e.shiftKey && (active === last || !dialogRef.current?.contains(active))) {
      e.preventDefault();
      first.focus();
    }
  };

  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={handleKeyDown}
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl"
      >
        <h2 id={titleId} className="mb-2 text-lg font-bold">{title}</h2>
        <p className="mb-4 text-sm text-gray-600">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            ref={cancelRef}
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            disabled={pending}
            className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-50"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
