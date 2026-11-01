/**
 * バックアップ・復旧のパネル（設定画面「バックアップ」）。OSS 版（self-hosted）だけで出す。
 *
 * - 復旧ツール（tools/recovery）の画面へのリンク。URL は、ビルド時に決まる（.env の VITE_RECOVERY_URL。
 *   例: http://192.168.0.62:8090）。未設定のときは、開き方だけを表示する。
 * - 書き戻し・R2 からの復旧は、復旧ツールの画面で行う（この画面では実行しない）。
 *
 * 【誰が使うか】SettingsPage.tsx が、OSS 版のときだけ「バックアップ」のタブで出す。引数（props）はない。
 */

// ビルド時に決まる、復旧ツールの画面の URL（未設定なら空）
const RECOVERY_URL: string = (import.meta.env.VITE_RECOVERY_URL ?? "").trim();

export function BackupSettingsPanel() {
  return (
    <div className="space-y-4">
      <section>
        <h2 className="mb-1 text-lg font-bold text-gray-900">復旧ツール</h2>
        <p className="text-sm text-gray-600">
          バックアップの中身を今のデータと比べ、必要なデータだけを戻せます。今ある行は変えず、無い行だけを足します。
        </p>
        {RECOVERY_URL ? (
          <a
            href={RECOVERY_URL}
            target="_blank"
            rel="noopener noreferrer"
            className="mt-3 inline-block rounded-lg bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
          >
            復旧ツールを開く
          </a>
        ) : (
          <p className="mt-3 rounded-lg bg-amber-50 p-3 text-sm text-amber-800">
            復旧ツールの URL が設定されていません。ビルド時の設定（VITE_RECOVERY_URL）に、復旧ツールの URL を入れてください。
          </p>
        )}
        <p className="mt-2 text-xs text-gray-500">
          復旧ツールは、ラズパイの LAN（同じネットワーク）からだけ開けます。外からは開かないでください。
        </p>
      </section>

      <section>
        <h2 className="mb-1 text-sm font-bold text-gray-900">できること</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-gray-700">
          <li>バックアップの一覧と、壊れていないかの確認</li>
          <li>今のデータとの比較（件数の差）</li>
          <li>書き戻し: 今のデータに無い行だけを足す（試算 → 確認 → 実行の順）</li>
          <li>R2 からの復旧: WAL-G の最新のバックアップから、一時的に DB を復元して比べる</li>
        </ul>
      </section>
    </div>
  );
}
