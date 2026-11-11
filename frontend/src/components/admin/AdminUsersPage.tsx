/**
 * 管理者の一覧画面。上部に全体の件数と DB の使用量、下に利用者の一覧（検索つき）を出す。
 * 行を選ぶと、利用者の詳細（AdminUserModal）を開く。
 *
 * 【誰が使うか】AdminApp.tsx が、管理者トークンがあるときに出す。
 * 【引数（props）】token=管理者トークン、onAuthError=トークンが失効（401）したときの処理（ログアウトさせる）。
 */
import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import { AdminApiError, fetchAdminOverview, fetchAdminUsers } from "../../lib/adminApi";
import type { AdminUserSummary } from "../../lib/adminApi";
import { FREE_TIER_SENSOR_LIMIT } from "../../lib/freeTier";
import { AdminUserModal } from "./AdminUserModal";
import { FailbackCard } from "./FailbackCard";
import { R2RestoreCard } from "./R2RestoreCard";
import { IngestLimitCard } from "./IngestLimitCard";

// 親（AdminApp）から受け取る値: 管理者トークンと、認証の失効を知らせる関数
interface Props {
  token: string;
  onAuthError: () => void;
}

/** バイト数を、読みやすい単位（B / KB / MB / GB）にする。 */
function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`;
}

/** 日時を、日本語の表記にする。無ければ「—」。 */
function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP");
}

/** 管理者の一覧画面の本体。 */
export function AdminUsersPage({ token, onAuthError }: Props) {
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  // 概要（件数と DB の使用量）と、利用者の一覧を、それぞれ取得する
  const overview = useQuery({
    queryKey: ["admin", "overview"],
    queryFn: () => fetchAdminOverview(token),
  });
  const users = useQuery({
    queryKey: ["admin", "users"],
    queryFn: () => fetchAdminUsers(token),
  });

  // 期限切れ・権限剥奪（401/403）は、再ログインへ戻す（ほかのエラーは、そのまま表示する）
  const authFailed = [overview.error, users.error].some(
    (e) => e instanceof AdminApiError && (e.status === 401 || e.status === 403),
  );
  useEffect(() => {
    if (authFailed) onAuthError();
  }, [authFailed, onAuthError]);

  const filtered: AdminUserSummary[] = useMemo(() => {
    const q = query.trim().toLowerCase();
    const list = users.data ?? [];
    if (!q) return list;
    return list.filter(
      (u) =>
        u.email.toLowerCase().includes(q) ||
        (u.workspaceName ?? "").toLowerCase().includes(q),
    );
  }, [users.data, query]);

  return (
    <div>
      <IngestLimitCard token={token} onAuthError={onAuthError} />
      <FailbackCard token={token} onAuthError={onAuthError} />
      <R2RestoreCard token={token} onAuthError={onAuthError} />
      <RecoveryToolCard />
      <section className="mb-6 grid grid-cols-2 gap-3 md:grid-cols-5">
        <Stat label="ユーザー数" value={overview.data?.userCount} />
        <Stat label="ワークスペース数" value={overview.data?.workspaceCount} />
        <Stat label="センサー数" value={overview.data?.sensorCount} />
        <Stat label="測定件数" value={overview.data?.readingCount} />
        <Stat
          label="DB使用量"
          value={overview.data ? formatBytes(overview.data.databaseSizeBytes) : undefined}
        />
      </section>

      <div className="mb-3 flex items-center gap-3">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="メール・ワークスペース名で検索"
          className="w-full max-w-xs rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
        <button
          type="button"
          onClick={() => {
            void overview.refetch();
            void users.refetch();
          }}
          className="rounded px-3 py-1.5 text-sm text-gray-500 hover:bg-gray-100"
        >
          再読み込み
        </button>
      </div>

      {users.isError && !authFailed && (
        <p className="mb-3 text-sm text-red-600">ユーザー一覧の取得に失敗しました: {users.error.message}</p>
      )}

      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <div className="overflow-x-auto">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">メール</th>
              <th className="px-3 py-2">ワークスペース</th>
              <th className="px-3 py-2">プラン</th>
              <th className="px-3 py-2">センサー</th>
              <th className="px-3 py-2">測定件数</th>
              <th className="px-3 py-2">最終測定</th>
              <th className="px-3 py-2">登録日</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {filtered.map((u) => (
              <tr key={u.id} className="border-t border-gray-100">
                <td className="px-3 py-2 text-gray-900">{u.email}</td>
                <td className="px-3 py-2 text-gray-600">{u.workspaceName ?? "—"}</td>
                <td className="px-3 py-2 text-gray-600">{u.plan ?? "—"}</td>
                <td className="px-3 py-2 text-gray-600">
                  {u.plan === "free" ? `${u.sensorCount} / ${FREE_TIER_SENSOR_LIMIT}` : u.sensorCount}
                </td>
                <td className="px-3 py-2 text-gray-600">{u.readingCount.toLocaleString()}</td>
                <td className="px-3 py-2 text-gray-600">{formatDateTime(u.lastReadingAt)}</td>
                <td className="px-3 py-2 text-gray-600">{formatDateTime(u.createdAt)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    onClick={() => setSelectedId(u.id)}
                    className="rounded px-2 py-1 text-xs text-blue-600 hover:bg-blue-50"
                  >
                    詳細・編集
                  </button>
                </td>
              </tr>
            ))}
            {users.isSuccess && filtered.length === 0 && (
              <tr>
                <td colSpan={8} className="px-3 py-6 text-center text-gray-500">
                  該当するユーザーはいません
                </td>
              </tr>
            )}
          </tbody>
        </table>
        </div>
      </div>

      {selectedId && (
        <AdminUserModal
          token={token}
          userId={selectedId}
          onClose={() => setSelectedId(null)}
          onChanged={() => {
            void users.refetch();
            void overview.refetch();
          }}
          onAuthError={onAuthError}
        />
      )}
    </div>
  );
}

/** ワークスペースを指定してのOSS版⇄SaaS版の移行は復旧ツールを使う、という案内。 */
function RecoveryToolCard() {
  return (
    <section className="mb-6 rounded border border-gray-200 bg-white p-4">
      <h2 className="mb-1 text-sm font-bold text-gray-900">OSS版⇄SaaS版の移行（復旧ツール）</h2>
      <p className="text-sm text-gray-600">
        ワークスペースを指定してのOSS版⇄SaaS版の移行（Free Tierの確認を含む）は、この画面ではなく復旧ツール（
        <code className="text-xs">tools/recovery/</code>
        ・127.0.0.1 または Tailscale のみ）で行います。
        <a
          href="https://github.com/hide23link/factoreye/tree/main/tools/recovery"
          target="_blank"
          rel="noopener noreferrer"
          className="ml-1 text-blue-500 hover:underline"
        >
          説明を見る
        </a>
      </p>
    </section>
  );
}

/** 数字の小さな見出し（ラベルと値）。概要の件数に使う。 */
function Stat({ label, value }: { label: string; value: number | string | undefined }) {
  return (
    <div className="rounded-lg border border-gray-200 bg-white p-3">
      <div className="text-xs text-gray-500">{label}</div>
      <div className="mt-1 text-xl font-semibold text-gray-900">
        {value === undefined ? "—" : typeof value === "number" ? value.toLocaleString() : value}
      </div>
    </div>
  );
}
