/**
 * 1 枚のウィジェットを、画面いっぱいに重ねて出す枠。Esc・「閉じる」で元に戻る。
 * ブラウザの全画面（画面表示モードが使う requestFullscreen）は使わない。表示モードと Esc が競合せず、スマホでも使えるため。
 * 中身は、呼び出し側が渡す（WidgetCard が、同じウィジェットの本体をもう 1 つ出す）。
 *
 * 【誰が使うか】WidgetCard が、メニューの「全画面で見る」を選んだときに出す。
 * 【引数（props）】label = 画面の読み上げ名、onClose = 閉じるとき、children = ウィジェットの本体。
 */
import { useEffect, useRef, type ReactNode } from "react";
import { createPortal } from "react-dom";

export function WidgetFullscreen({ label, onClose, children }: { label: string; onClose: () => void; children: ReactNode }) {
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // 開いたとき、閉じるボタンにフォーカスする（Esc が届き、キーボードでも閉じられる）。閉じたら、元の場所へ戻す
    const before = document.activeElement as HTMLElement | null;
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("keydown", onKey);
      before?.focus?.();
    };
  }, [onClose]);

  return createPortal(
    <div role="dialog" aria-modal="true" aria-label={label} className="fixed inset-0 z-50 flex flex-col bg-white p-3 sm:p-4">
      <div className="mb-2 flex shrink-0 items-center gap-2">
        <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-gray-800">{label}</h2>
        <button
          ref={closeRef}
          type="button"
          aria-label="全画面を閉じる"
          onClick={onClose}
          className="rounded border border-gray-200 px-2 py-1 text-xs text-gray-700 hover:bg-gray-100"
        >
          閉じる（Esc）
        </button>
      </div>
      <div className="min-h-0 flex-1 overflow-hidden">{children}</div>
    </div>,
    document.body,
  );
}
