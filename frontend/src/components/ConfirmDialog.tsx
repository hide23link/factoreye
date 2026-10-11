/**
 * 「本当に実行しますか？」の確認の小窓（削除など、元に戻せない操作の前に出す）。
 * ブラウザ標準の confirm は使わず、画面の中で確認する。
 * ウィジェットの枠（react-grid-layout のグリッド）の中から呼ばれても画面全体に出るよう、document.body へ portal する。
 */
import { createPortal } from "react-dom";

export function ConfirmDialog({
  title,
  message,
  confirmLabel = "削除",
  onConfirm,
  onCancel,
}: {
  title: string;
  message: string;
  confirmLabel?: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 p-4">
      <div
        role="alertdialog"
        aria-modal="true"
        aria-label={title}
        className="w-full max-w-sm rounded-lg bg-white p-4 shadow-xl"
      >
        <h2 className="mb-2 text-lg font-bold">{title}</h2>
        <p className="mb-4 text-sm text-gray-600">{message}</p>
        <div className="flex justify-end gap-2">
          <button
            type="button"
            onClick={onCancel}
            className="rounded px-3 py-1.5 text-sm text-gray-600 hover:bg-gray-100"
          >
            キャンセル
          </button>
          <button
            type="button"
            onClick={onConfirm}
            className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
