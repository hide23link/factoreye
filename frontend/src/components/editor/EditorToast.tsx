/**
 * 画面下の通知（「削除しました［元に戻す］」など）。操作つきの通知は 6 秒、ほかは 2.6 秒で消える。
 * 読み上げソフトにも伝わるよう、role="status" にする。
 *
 * 【誰が使うか】DashboardView。
 */
import { useEffect } from "react";

import { useEditorStore } from "../../store/useEditorStore";

export function EditorToast() {
  const toast = useEditorStore((s) => s.toast);
  const clear = useEditorStore((s) => s.clearToast);

  // 通知が変わるたびに、消すまでの時間を数え直す
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(clear, toast.action ? 6000 : 2600);
    return () => clearTimeout(timer);
  }, [toast, clear]);

  return (
    <div role="status" aria-live="polite" className="pointer-events-none fixed inset-x-0 bottom-5 z-[60] flex justify-center px-4">
      {toast && (
        <div className="pointer-events-auto flex max-w-full items-center gap-3 rounded-lg bg-gray-900 px-3.5 py-2 text-sm text-white shadow-lg">
          <span>{toast.message}</span>
          {toast.action && (
            <button
              type="button"
              onClick={() => {
                toast.action?.run();
                clear();
              }}
              className="rounded border border-white/70 px-2 py-0.5 text-xs hover:bg-white/10"
            >
              {toast.action.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}
