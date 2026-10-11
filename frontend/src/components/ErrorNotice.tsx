/**
 * データを取得できなかったときの表示。説明と、「再試行」ボタン（onRetry があるとき）を出す。
 * 「読み込み中...」のまま止まらないよう、取得に失敗した画面で使う。
 */
export function ErrorNotice({
  message = "データを取得できませんでした。",
  onRetry,
  children,
}: {
  message?: string;
  onRetry?: () => void;
  children?: React.ReactNode;
}) {
  return (
    <div role="alert" className="flex flex-wrap items-center gap-2 p-1 text-sm text-red-600">
      <span>{message}</span>
      {onRetry && (
        <button
          type="button"
          onClick={onRetry}
          className="rounded border border-red-300 px-2 py-0.5 text-xs text-red-600 hover:bg-red-50"
        >
          再試行
        </button>
      )}
      {children}
    </div>
  );
}
