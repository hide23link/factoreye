/**
 * データ移行のパネル（設定画面「データ移行」）。
 *
 * - SaaS 版: 書き出し（ログイン中のワークスペースを、gzip のファイルとして保存する）
 * - OSS 版: 取り込み（書き出しファイルを選び、確認（dry-run）→ 取り込む、の2段階）
 *
 * どちらが使えるかは、バックエンドの状態（/api/settings/migration/status）で決まる。
 */
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { useMigrationStatus } from "../../hooks/queries";
import { downloadWorkspaceExport, importWorkspaceFile } from "../../lib/api";
import type { MigrationImportResult } from "../../types";

// テーブル名を、画面に出す日本語の名前にする（一覧に出す件数の見出し）
const TABLE_LABELS: Record<string, string> = {
  sensors: "センサー",
  readings: "測定値",
  alarms: "アラーム",
  dashboards: "ダッシュボード",
  widgets: "ウィジェット",
  widget_configs: "ウィジェット設定",
  webhook_subscriptions: "Webhook連携",
  notification_settings: "通知設定",
};

// 書き出しのダウンロード時のファイル名
const EXPORT_FILE_NAME = "factoreye-workspace.jsonl.gz";

/** テーブルごとの件数を、見出し付きの一覧で表示する。 */
function CountList({ counts }: { counts: Record<string, number> }) {
  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-1 text-sm text-gray-700">
      {Object.entries(counts).map(([table, count]) => (
        <li key={table}>
          {TABLE_LABELS[table] ?? table}: {count.toLocaleString("ja-JP")} 件
        </li>
      ))}
    </ul>
  );
}

/** 書き出しの節（SaaS 版）。押すと、ワークスペースのファイルをダウンロードさせる。 */
function ExportSection() {
  const [error, setError] = useState<string | null>(null);

  const exportMutation = useMutation({
    mutationFn: downloadWorkspaceExport,
    onSuccess: (blob) => {
      // 一時的な URL を作ってダウンロードさせ、すぐ解放する
      const url = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = url;
      link.download = EXPORT_FILE_NAME;
      link.click();
      // Safari はクリック直後に解放するとダウンロードが止まるため、少し遅らせる
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  return (
    <section className="space-y-2">
      <h3 className="text-base font-bold text-gray-900">書き出し（SaaS → OSS）</h3>
      <p className="text-xs text-gray-500">
        このワークスペースのセンサー・測定値・アラーム・ダッシュボード・Webhook連携を、OSS版に移すためのファイルとして書き出します。ユーザー情報とログイン情報は含みません。
      </p>
      <button
        type="button"
        onClick={() => exportMutation.mutate()}
        disabled={exportMutation.isPending}
        className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {exportMutation.isPending ? "書き出し中..." : "書き出す"}
      </button>
      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}

/**
 * 取り込みの節（OSS 版）。
 * 1. ファイルを選ぶ 2. 「内容を確認」で件数を見る（DB は変えない）3. 「この内容で取り込む」で実際に入れる
 * ファイルや通知の設定を変えると、確認の結果は消す（古い結果で取り込まないため）。
 */
function ImportSection() {
  const [file, setFile] = useState<File | null>(null);
  const [withNotifications, setWithNotifications] = useState(false);
  // 確認（dry-run）の結果。ファイルや設定を変えたら作り直すので、古い結果は残さない
  const [preview, setPreview] = useState<MigrationImportResult | null>(null);
  const [done, setDone] = useState<MigrationImportResult | null>(null);
  const [error, setError] = useState<string | null>(null);

  const changeFile = (next: File | null) => {
    setFile(next);
    setPreview(null);
    setDone(null);
    setError(null);
  };

  const previewMutation = useMutation({
    mutationFn: () => importWorkspaceFile(file as File, { dryRun: true, withNotifications }),
    onSuccess: (result) => {
      setPreview(result);
      setError(null);
    },
    onError: (e: Error) => {
      setPreview(null);
      setError(e.message);
    },
  });

  const importMutation = useMutation({
    mutationFn: () => importWorkspaceFile(file as File, { dryRun: false, withNotifications }),
    onSuccess: (result) => {
      setDone(result);
      setPreview(null);
      setError(null);
    },
    onError: (e: Error) => setError(e.message),
  });

  const busy = previewMutation.isPending || importMutation.isPending;

  return (
    <section className="space-y-3">
      <h3 className="text-base font-bold text-gray-900">取り込み（OSS へ移す）</h3>
      <p className="text-xs text-gray-500">
        SaaS版で書き出したファイル（.jsonl.gz）を選び、まず内容を確認してから取り込みます。取り込みは途中で失敗すると全体を取り消します。移行先のデータは消えませんが、同じ ID のデータがあると取り込めません。
      </p>

      <input
        type="file"
        aria-label="取り込むファイル"
        accept=".gz,application/gzip"
        onChange={(e) => changeFile(e.target.files?.[0] ?? null)}
        className="block text-sm"
      />

      <label className="flex items-start gap-2 text-sm text-gray-700">
        <input
          type="checkbox"
          checked={withNotifications}
          onChange={(e) => {
            setWithNotifications(e.target.checked);
            setPreview(null);
          }}
          className="mt-0.5"
        />
        <span>
          通知設定も移す
          <span className="block text-xs text-gray-400">
            移行先の Discord 通知設定（現在の値）を、ファイルの内容で上書きします。
          </span>
        </span>
      </label>

      <button
        type="button"
        onClick={() => previewMutation.mutate()}
        disabled={!file || busy}
        className="rounded border border-gray-300 px-3 py-1.5 text-sm text-gray-700 hover:bg-gray-50 disabled:opacity-50"
      >
        {previewMutation.isPending ? "確認中..." : "内容を確認"}
      </button>

      {preview && (
        <div className="space-y-2 rounded border border-blue-200 bg-blue-50 p-3">
          <p className="text-sm font-medium text-gray-900">取り込める件数</p>
          <CountList counts={preview.counts} />
          <button
            type="button"
            onClick={() => importMutation.mutate()}
            disabled={busy}
            className="rounded bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
          >
            {importMutation.isPending ? "取り込み中..." : "この内容で取り込む"}
          </button>
        </div>
      )}

      {done && (
        <div className="space-y-2 rounded border border-green-200 bg-green-50 p-3">
          <p className="text-sm font-medium text-green-800">取り込みが完了しました</p>
          <CountList counts={done.counts} />
        </div>
      )}

      {error && <p className="text-xs text-red-600">{error}</p>}
    </section>
  );
}

/** データ移行パネルの本体。状態を取得し、使える節だけを表示する。 */
export function MigrationSettingsPanel() {
  const { data: status, isLoading, isError } = useMigrationStatus();

  if (isLoading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (isError || !status) {
    return <p className="text-sm text-red-600">移行機能の状態を取得できませんでした</p>;
  }
  if (!status.canExport && !status.canImport) {
    return <p className="text-sm text-gray-500">このサーバーでは移行機能を使えません。</p>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h2 className="mb-1 text-lg font-bold text-gray-900">データ移行</h2>
        <p className="text-xs text-gray-400">
          SaaS版のワークスペースを、OSS版（セルフホスト）へ移します。
        </p>
      </div>
      {status.canExport && <ExportSection />}
      {status.canExport && status.canImport && <hr className="border-gray-200" />}
      {status.canImport && <ImportSection />}
    </div>
  );
}
