/**
 * 「ログイン端末」パネル（設定画面）。SaaS 版だけで出す。パスワードは使わず、端末のパスキーでログインする。
 *
 * - 登録した端末（パスキー）の一覧: 名前・登録日・最後に使った日。名前を変える・消す・この端末を足す。
 *   最後の 1 台は消せない（ログインできなくなるため）。メールのログインリンクだけで入っているときは、
 *   端末の管理はできない（サーバーが 403 を返すので、ここでも案内だけを出す）。
 * - ログインしたままにする（キオスク用）: この端末のログインを期限なし（ずっと）にする。壁掛けの画面など、
 *   ログインし直す人がいない端末のための機能。選ぶ前に、リスク（端末を盗まれると全権限を使われる）を
 *   見せて確認する。永久ログインの端末の一覧（名前・開始日・最後に使った日）と、「ログインを終了」を出す。
 *
 * 【誰が使うか】SettingsPage.tsx が、SaaS 版のときだけ「ログイン端末」のタブで出す。引数（props）はない。
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import {
  beginAddPasskey,
  deletePasskey,
  endKeptSession,
  fetchKeptSessions,
  fetchPasskeys,
  finishAddPasskey,
  keepSignedIn,
  renamePasskey,
} from "../../lib/api";
import { describeActionError } from "../../lib/errors";
import { PasskeyCancelledError, createPasskey, defaultDeviceName } from "../../lib/passkey";
import { getStoredRefreshToken, useAuthStore } from "../../store/useAuthStore";
import type { KeptSession, PasskeyItem } from "../../types";
import { ConfirmDialog } from "../ConfirmDialog";

const PASSKEYS_KEY = ["passkeys"] as const;
const KEPT_KEY = ["kept-sessions"] as const;

/** 日付を「2026/11/23」の形にする。読めなければ「—」。 */
function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? "—" : date.toLocaleDateString("ja-JP");
}

/** 端末の名前を、その場で変える入力（Enter で保存、Esc でやめる）。 */
function RenameCell({ item, onSave }: { item: PasskeyItem; onSave: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(item.name);

  if (!editing) {
    return (
      <span className="flex items-center gap-2">
        {item.name}
        <button
          type="button"
          onClick={() => setEditing(true)}
          aria-label={`${item.name} の名前を変える`}
          className="text-xs text-blue-600 hover:underline"
        >
          名前を変える
        </button>
      </span>
    );
  }
  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (name.trim()) {
          onSave(name.trim());
          setEditing(false);
        }
      }}
    >
      <input
        aria-label="端末の名前"
        value={name}
        maxLength={50}
        onChange={(event) => setName(event.target.value)}
        onKeyDown={(event) => event.key === "Escape" && setEditing(false)}
        className="rounded border border-gray-300 px-2 py-1 text-sm"
      />
      <button type="submit" className="text-xs text-blue-600 hover:underline">
        保存
      </button>
    </form>
  );
}

/** 端末（パスキー）の一覧と、追加・名前変更・削除。 */
function PasskeyList() {
  const queryClient = useQueryClient();
  const passkeys = useQuery({ queryKey: PASSKEYS_KEY, queryFn: fetchPasskeys });
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [toDelete, setToDelete] = useState<PasskeyItem | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: PASSKEYS_KEY });

  // この端末を足す: 端末の確認画面（指紋・顔・PIN）を出して、できたパスキーを送る
  const add = useMutation({
    mutationFn: async () => {
      const begin = await beginAddPasskey();
      const credential = await createPasskey(begin.options);
      return finishAddPasskey({
        challengeId: begin.challengeId,
        credential,
        deviceName: deviceName.trim(),
      });
    },
    onSuccess: () => {
      setError(null);
      void refresh();
    },
    onError: (err) => {
      // 端末の画面をやめただけなら、エラーにしない
      if (!(err instanceof PasskeyCancelledError)) setError(describeActionError(err, "端末の追加"));
    },
  });
  const rename = useMutation({
    mutationFn: (v: { id: string; name: string }) => renamePasskey(v.id, v.name),
    onSuccess: () => void refresh(),
    onError: (err) => setError(describeActionError(err, "名前の変更")),
  });
  const remove = useMutation({
    mutationFn: (id: string) => deletePasskey(id),
    onSuccess: () => {
      setToDelete(null);
      void refresh();
    },
    onError: (err) => {
      setToDelete(null);
      setError(describeActionError(err, "端末の削除"));
    },
  });

  const items = passkeys.data ?? [];
  return (
    <section aria-labelledby="passkeys-heading" className="space-y-3">
      <h3 id="passkeys-heading" className="text-sm font-bold text-gray-900">
        登録した端末（パスキー）
      </h3>
      {passkeys.isError && <p className="text-sm text-red-600">端末の一覧を取得できませんでした。</p>}
      <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
        <table className="min-w-full text-left text-sm">
          <thead className="bg-gray-50 text-xs text-gray-500">
            <tr>
              <th className="px-3 py-2">名前</th>
              <th className="px-3 py-2">登録日</th>
              <th className="px-3 py-2">最後に使った日</th>
              <th className="px-3 py-2"></th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <tr key={item.id} className="border-t border-gray-100">
                <td className="px-3 py-2 text-gray-900">
                  <RenameCell item={item} onSave={(name) => rename.mutate({ id: item.id, name })} />
                </td>
                <td className="px-3 py-2 text-gray-600">{formatDate(item.createdAt)}</td>
                <td className="px-3 py-2 text-gray-600">{formatDate(item.lastUsedAt)}</td>
                <td className="px-3 py-2 text-right">
                  <button
                    type="button"
                    disabled={items.length <= 1}
                    title={items.length <= 1 ? "最後の 1 台は消せません" : undefined}
                    aria-label={`${item.name} を削除`}
                    onClick={() => setToDelete(item)}
                    className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:cursor-not-allowed disabled:opacity-40"
                  >
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {items.length === 1 && (
        <p className="text-xs text-gray-500">
          端末が 1 台だけです。もう 1 台登録しておくと、1 台を失くしても入れます。
        </p>
      )}
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="new-passkey-name" className="mb-1 block text-xs text-gray-500">
            この端末の名前
          </label>
          <input
            id="new-passkey-name"
            value={deviceName}
            maxLength={50}
            onChange={(event) => setDeviceName(event.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          disabled={add.isPending}
          onClick={() => add.mutate()}
          className="rounded bg-blue-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
        >
          ＋ この端末を追加
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {toDelete && (
        <ConfirmDialog
          title="端末を削除しますか？"
          message={`「${toDelete.name}」のパスキーを削除します。その端末では、パスキーでログインできなくなります。`}
          onConfirm={() => remove.mutate(toDelete.id)}
          onCancel={() => setToDelete(null)}
          pending={remove.isPending}
        />
      )}
    </section>
  );
}

/** ログインしたままにする（キオスク用）の設定と、永久ログインの端末の一覧。 */
function KeptSessions() {
  const queryClient = useQueryClient();
  const kept = useQuery({ queryKey: KEPT_KEY, queryFn: fetchKeptSessions });
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [confirming, setConfirming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = () => queryClient.invalidateQueries({ queryKey: KEPT_KEY });

  const keep = useMutation({
    mutationFn: async () => {
      const refreshToken = getStoredRefreshToken();
      if (!refreshToken) throw new Error("no refresh token");
      return keepSignedIn(refreshToken, deviceName.trim());
    },
    onSuccess: () => {
      setConfirming(false);
      setError(null);
      void refresh();
    },
    onError: (err) => {
      setConfirming(false);
      setError(describeActionError(err, "ログインしたままにする設定"));
    },
  });
  const end = useMutation({
    mutationFn: (id: string) => endKeptSession(id),
    onSuccess: () => void refresh(),
    onError: (err) => setError(describeActionError(err, "ログインの終了")),
  });

  const items: KeptSession[] = kept.data ?? [];
  return (
    <section aria-labelledby="kept-heading" className="space-y-3">
      <h3 id="kept-heading" className="text-sm font-bold text-gray-900">
        ログインしたままにする（キオスク用）
      </h3>
      <p className="text-sm text-gray-600">
        壁掛けの画面など、ログインし直す人がいない端末のために、この端末のログインを<b>期限なし</b>
        にできます（通常は 180 日）。
      </p>
      <p role="note" className="rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-900">
        リスク: この端末を盗まれると、その人があなたの全権限で使い続けられます。「ログインを終了」するまで続きます。
        人目につく場所の、管理できる端末だけに使ってください。
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label htmlFor="kept-device-name" className="mb-1 block text-xs text-gray-500">
            この端末の名前
          </label>
          <input
            id="kept-device-name"
            value={deviceName}
            maxLength={50}
            onChange={(event) => setDeviceName(event.target.value)}
            className="rounded border border-gray-300 px-2 py-1.5 text-sm"
          />
        </div>
        <button
          type="button"
          onClick={() => setConfirming(true)}
          className="rounded border border-gray-300 px-3 py-1.5 text-sm hover:bg-gray-50"
        >
          この端末はログインしたままにする（キオスク用）
        </button>
      </div>
      {error && (
        <p role="alert" className="text-sm text-red-600">
          {error}
        </p>
      )}
      {items.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-gray-200 bg-white">
          <table aria-label="ログインしたままの端末" className="min-w-full text-left text-sm">
            <thead className="bg-gray-50 text-xs text-gray-500">
              <tr>
                <th className="px-3 py-2">名前</th>
                <th className="px-3 py-2">開始日</th>
                <th className="px-3 py-2">最後に使った日</th>
                <th className="px-3 py-2"></th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => (
                <tr key={item.id} className="border-t border-gray-100">
                  <td className="px-3 py-2 text-gray-900">{item.name || "（名前なし）"}</td>
                  <td className="px-3 py-2 text-gray-600">{formatDate(item.startedAt)}</td>
                  <td className="px-3 py-2 text-gray-600">{formatDate(item.lastUsedAt)}</td>
                  <td className="px-3 py-2 text-right">
                    <button
                      type="button"
                      aria-label={`${item.name || "この端末"} のログインを終了`}
                      disabled={end.isPending}
                      onClick={() => end.mutate(item.id)}
                      className="rounded px-2 py-1 text-xs text-red-600 hover:bg-red-50 disabled:opacity-50"
                    >
                      ログインを終了
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {confirming && (
        <ConfirmDialog
          title="この端末のログインを、期限なしにしますか？"
          message="この端末を盗まれると、その人があなたの全権限で使い続けられます（「ログインを終了」するまで）。壁掛けの画面など、管理できる端末だけに使ってください。"
          confirmLabel="ログインしたままにする"
          confirmTone="primary"
          onConfirm={() => keep.mutate()}
          onCancel={() => setConfirming(false)}
          pending={keep.isPending}
        />
      )}
    </section>
  );
}

/** 設定パネル。 */
export function PasskeysSettingsPanel() {
  const loginMethod = useAuthStore((s) => s.me?.loginMethod);
  // メールのログインリンクだけで入ったとき（と古いログイン）は、端末の管理はできない
  const canManage = loginMethod === "passkey" || loginMethod === "recover";
  return (
    <div className="space-y-8">
      <h2 className="text-base font-bold text-gray-900">ログイン端末</h2>
      {canManage ? (
        <PasskeyList />
      ) : (
        <p role="note" className="rounded border border-gray-200 bg-white px-3 py-2 text-sm text-gray-700">
          メールのリンクでログインしているため、端末（パスキー）の追加・削除はできません。端末を管理するには、
          パスキーでログインし直してください。
        </p>
      )}
      <KeptSessions />
    </div>
  );
}
