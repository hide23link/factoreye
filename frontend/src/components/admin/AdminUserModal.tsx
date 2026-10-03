import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";

import {
  AdminApiError,
  deleteAdminUser,
  fetchAdminUser,
  updateAdminUser,
} from "../../lib/adminApi";
import { FREE_TIER_SENSOR_LIMIT } from "../../lib/freeTier";

interface Props {
  token: string;
  userId: string;
  onClose: () => void;
  onChanged: () => void;
  onAuthError: () => void;
}

function formatDateTime(iso: string | null): string {
  if (!iso) return "—";
  return new Date(iso).toLocaleString("ja-JP");
}

export function AdminUserModal({ token, userId, onClose, onChanged, onAuthError }: Props) {
  const queryClient = useQueryClient();
  const detail = useQuery({
    queryKey: ["admin", "user", userId],
    queryFn: () => fetchAdminUser(token, userId),
  });

  const [email, setEmail] = useState("");
  const [plan, setPlan] = useState<"free" | "pro">("free");
  const [password, setPassword] = useState("");
  const [confirmEmail, setConfirmEmail] = useState("");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // 取得できたら編集フォームの初期値に反映する
  useEffect(() => {
    if (detail.data) {
      setEmail(detail.data.email);
      setPlan(detail.data.plan === "pro" ? "pro" : "free");
    }
  }, [detail.data]);

  const authFailed =
    detail.error instanceof AdminApiError && (detail.error.status === 401 || detail.error.status === 403);
  useEffect(() => {
    if (authFailed) onAuthError();
  }, [authFailed, onAuthError]);

  const refreshAll = () => {
    void queryClient.invalidateQueries({ queryKey: ["admin"] });
    onChanged();
  };

  const saveMutation = useMutation({
    mutationFn: () => {
      const data: { email?: string; plan?: "free" | "pro"; password?: string } = {};
      if (detail.data && email !== detail.data.email) data.email = email;
      if (detail.data && plan !== detail.data.plan) data.plan = plan;
      if (password) data.password = password;
      return updateAdminUser(token, userId, data);
    },
    onSuccess: () => {
      setPassword("");
      setError(null);
      setMessage("保存しました");
      refreshAll();
    },
    onError: (e: Error) => {
      setMessage(null);
      setError(e.message.includes("409") ? "そのメールアドレスは既に使われています" : e.message);
    },
  });

  const deleteMutation = useMutation({
    mutationFn: () => deleteAdminUser(token, userId),
    onSuccess: () => {
      refreshAll();
      onClose();
    },
    onError: (e: Error) => setError(`削除に失敗しました: ${e.message}`),
  });

  const canDelete = !!detail.data && confirmEmail === detail.data.email;
  const passwordTooShort = password.length > 0 && password.length < 8;

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/40 p-4">
      <div className="my-8 w-full max-w-3xl rounded-lg bg-white p-6 shadow-xl">
        <div className="mb-4 flex items-start justify-between">
          <div>
            <h2 className="text-lg font-bold text-gray-900">{detail.data?.email ?? "読み込み中..."}</h2>
            {detail.data && (
              <p className="text-xs text-gray-400">
                ワークスペース: {detail.data.workspaceName ?? "—"} ／ 登録日:{" "}
                {formatDateTime(detail.data.createdAt)}
              </p>
            )}
          </div>
          <button type="button" onClick={onClose} className="text-sm text-gray-500 hover:text-gray-800">
            閉じる
          </button>
        </div>

        {detail.isError && !authFailed && (
          <p className="mb-3 text-sm text-red-600">取得に失敗しました: {detail.error.message}</p>
        )}

        {detail.data && (
          <>
            <section className="mb-6">
              <h3 className="mb-2 text-sm font-semibold text-gray-700">センサー登録状況</h3>
              <p className="mb-2 text-sm text-gray-600">
                登録数:{" "}
                {detail.data.plan === "free"
                  ? `${detail.data.sensorCount} / ${FREE_TIER_SENSOR_LIMIT}（無料プラン上限）`
                  : detail.data.sensorCount}{" "}
                ／ 測定件数: {detail.data.readingCount.toLocaleString()} ／ 最終測定:{" "}
                {formatDateTime(detail.data.lastReadingAt)}
              </p>
              {detail.data.sensors.length === 0 ? (
                <p className="text-sm text-gray-400">センサーは未登録です</p>
              ) : (
                <table className="min-w-full text-left text-sm">
                  <thead className="bg-gray-50 text-xs text-gray-500">
                    <tr>
                      <th className="px-2 py-1.5">名前</th>
                      <th className="px-2 py-1.5">単位</th>
                      <th className="px-2 py-1.5">状態</th>
                      <th className="px-2 py-1.5">測定件数</th>
                      <th className="px-2 py-1.5">最終測定</th>
                      <th className="px-2 py-1.5">発生中アラーム</th>
                    </tr>
                  </thead>
                  <tbody>
                    {detail.data.sensors.map((s) => (
                      <tr key={s.id} className="border-t border-gray-100">
                        <td className="px-2 py-1.5">{s.name}</td>
                        <td className="px-2 py-1.5">{s.unit}</td>
                        <td className="px-2 py-1.5">{s.enabled ? "有効" : "無効"}</td>
                        <td className="px-2 py-1.5">{s.readingCount.toLocaleString()}</td>
                        <td className="px-2 py-1.5">{formatDateTime(s.lastReadingAt)}</td>
                        <td className="px-2 py-1.5">{s.activeAlarmCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </section>

            <section className="mb-6 rounded border border-gray-200 p-4">
              <h3 className="mb-3 text-sm font-semibold text-gray-700">修正</h3>
              <div className="grid gap-3 md:grid-cols-3">
                <label className="text-sm text-gray-700">
                  メールアドレス
                  <input
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </label>
                <label className="text-sm text-gray-700">
                  プラン
                  <select
                    value={plan}
                    onChange={(e) => setPlan(e.target.value as "free" | "pro")}
                    className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  >
                    <option value="free">free</option>
                    <option value="pro">pro</option>
                  </select>
                </label>
                <label className="text-sm text-gray-700">
                  新しいパスワード（変更時のみ）
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="new-password"
                    className="mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
                  />
                </label>
              </div>
              <p className="mt-2 text-xs text-gray-400">
                パスワードを変更すると、そのユーザーの既存のログインは全て無効になります。
              </p>
              {passwordTooShort && (
                <p className="mt-2 text-sm text-red-600">パスワードは8文字以上にしてください</p>
              )}
              <div className="mt-3 flex items-center gap-3">
                <button
                  type="button"
                  disabled={saveMutation.isPending || passwordTooShort}
                  onClick={() => saveMutation.mutate()}
                  className="rounded bg-gray-900 px-3 py-1.5 text-sm text-white hover:bg-gray-700 disabled:opacity-50"
                >
                  保存
                </button>
                {message && <span className="text-sm text-green-700">{message}</span>}
                {error && <span className="text-sm text-red-600">{error}</span>}
              </div>
            </section>

            <section className="rounded border border-red-200 bg-red-50 p-4">
              <h3 className="mb-2 text-sm font-semibold text-red-700">ユーザーの削除</h3>
              <p className="mb-3 text-xs text-red-700">
                ワークスペース・センサー・測定データ・ダッシュボードをすべて物理削除します。元に戻せません。
                確認のため、メールアドレス「{detail.data.email}」を入力してください。
              </p>
              <div className="flex flex-wrap items-center gap-2">
                <input
                  value={confirmEmail}
                  onChange={(e) => setConfirmEmail(e.target.value)}
                  placeholder={detail.data.email}
                  className="w-full max-w-xs rounded border border-red-300 px-2 py-1.5 text-sm"
                />
                <button
                  type="button"
                  disabled={!canDelete || deleteMutation.isPending}
                  onClick={() => deleteMutation.mutate()}
                  className="rounded bg-red-600 px-3 py-1.5 text-sm text-white hover:bg-red-700 disabled:opacity-40"
                >
                  このユーザーを削除
                </button>
              </div>
            </section>
          </>
        )}
      </div>
    </div>
  );
}
