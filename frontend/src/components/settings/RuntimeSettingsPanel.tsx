/**
 * 「API・取り込み」設定パネル（設定画面）。配布版（OSS / self-hosted）だけで出す。
 *
 * サーバーの設定ファイル（config/.env）の、取り込みに関する項目を見て、変える。
 * - 見るだけなら、パスワードは要らない（ロック中）。
 * - 「変更する」→ 管理パスワードで解錠（30 分有効）→ 入力 →「保存して再起動」。
 *   保存すると、サーバーが .env を書き換えて自分を再起動する。画面は、戻るのを待ってから表示を取り直す。
 * - .env を直接編集したときは、「ファイルの内容を反映」（パスワード不要）で、再起動して取り込む。
 *
 * 【誰が使うか】SettingsPage.tsx が、OSS 版のときだけ、選んだタブで出す。引数（props）はない。
 * 【API】lib/api.ts の Runtime Settings（backend/app/api/runtime_settings.py）。
 */
import { useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { useRuntimeSettings } from "../../hooks/queries";
import {
  changeRuntimePassword,
  reflectRuntimeSettings,
  saveRuntimeSettings,
  unlockRuntimeSettings,
  waitForBackendRestart,
} from "../../lib/api";
import { describeActionError, errorDetails, errorStatus } from "../../lib/errors";
import { buildChanges, generateIngestKey, toForm, type RuntimeForm } from "../../lib/runtime-settings";
import type { RuntimeSettings } from "../../types";
import { ErrorNotice } from "../ErrorNotice";

/** 許可証（解錠のしるし）。画面を閉じると消える（保存しない）。 */
interface Unlock {
  token: string;
  expiresAt: number;
}

/** 画面上部に出す知らせ。lines は箇条書き（検査の誤りなど）。 */
interface Notice {
  kind: "ok" | "error";
  text: string;
  lines?: string[];
}

const inputClass = "mt-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm disabled:bg-gray-100";

function isUnlockValid(unlock: Unlock | null): unlock is Unlock {
  return unlock !== null && unlock.expiresAt > Date.now();
}

/** 設定パネル。 */
export function RuntimeSettingsPanel() {
  const { data, isLoading, isError, refetch } = useRuntimeSettings();
  const queryClient = useQueryClient();

  const [unlock, setUnlock] = useState<Unlock | null>(null);
  const [form, setForm] = useState<RuntimeForm | null>(null); // null = 閲覧のみ
  const [newKey, setNewKey] = useState<string | null>(null);
  const [askPassword, setAskPassword] = useState(false);
  const [restarting, setRestarting] = useState(false);
  const [notice, setNotice] = useState<Notice | null>(null);

  if (isLoading) return <p className="text-sm text-gray-400">読み込み中...</p>;
  if (isError || !data) {
    return <ErrorNotice message="設定を取得できませんでした。" onRetry={() => void refetch()} />;
  }

  const editing = form !== null;
  const stopEditing = () => {
    setForm(null);
    setNewKey(null);
  };
  const startEditing = () => {
    setNotice(null);
    setForm(toForm(data));
  };

  /** 再起動を頼んだあとの共通の流れ: 戻るのを待つ → 画面全体の値を取り直す → 結果を知らせる。 */
  const waitAndRefresh = async (successText: string) => {
    setRestarting(true);
    stopEditing();
    const back = await waitForBackendRestart();
    setRestarting(false);
    if (!back) {
      setNotice({
        kind: "error",
        text: "サーバーが戻りません。サーバーで ./factoreye.sh logs を確認し、直前の設定に戻すなら ./factoreye.sh restore-env を実行してください。",
      });
      return;
    }
    await queryClient.invalidateQueries();
    setNotice({ kind: "ok", text: successText });
  };

  /** 保存・反映の失敗を、知らせにする。401（許可証の期限切れ）は、解錠し直しを求める。 */
  const showFailure = (error: unknown, action: string) => {
    if (errorStatus(error) === 401) {
      setUnlock(null);
      stopEditing();
      setNotice({ kind: "error", text: "管理パスワードの確認が切れました。もう一度「変更する」を押してください。" });
      return;
    }
    const lines = errorDetails(error);
    setNotice({ kind: "error", text: lines.length > 0 ? `${action}できませんでした。内容を直してください。` : describeActionError(error, action), lines });
  };

  const save = async () => {
    if (!form || !isUnlockValid(unlock)) return;
    const changes = buildChanges(data, form, newKey);
    if (Object.keys(changes).length === 0) {
      setNotice({ kind: "error", text: "変更された項目がありません。" });
      return;
    }
    try {
      await saveRuntimeSettings(changes, unlock.token);
    } catch (error) {
      showFailure(error, "保存");
      return;
    }
    await waitAndRefresh("保存して、再起動しました。（直前の内容は config/.env.bak に残してあります）");
  };

  const reflect = async () => {
    setNotice(null);
    try {
      await reflectRuntimeSettings();
    } catch (error) {
      if (errorStatus(error) === 409) {
        setNotice({ kind: "error", text: "設定ファイルは、起動したときから変わっていません。" });
      } else {
        showFailure(error, "反映");
      }
      return;
    }
    await waitAndRefresh(".env の内容を反映しました（再起動済み）。表示を更新しました。");
  };

  const changePassword = async (password: string) => {
    if (!isUnlockValid(unlock)) return;
    try {
      await changeRuntimePassword(password, unlock.token);
    } catch (error) {
      showFailure(error, "パスワードの変更");
      return;
    }
    await waitAndRefresh("管理パスワードを変更しました。");
  };

  return (
    <div>
      <div className="mb-3 flex items-center justify-between">
        <h2 className="text-lg font-bold text-gray-900">API・取り込み</h2>
        <span className="text-xs text-gray-500">{editing ? "🔓 変更できます" : "🔒 閲覧のみ"}</span>
      </div>
      <p className="mb-4 text-sm text-gray-500">
        機器からの取り込みに関する設定です。サーバーの設定ファイル（<code className="rounded bg-gray-100 px-1">/opt/factoreye/config/.env</code>）の内容で、
        ここで保存するとそのファイルが書き換わり、バックエンドが数秒で再起動します（その間、取り込みは一瞬止まります）。
        ファイルを直接編集してもかまいません。
      </p>

      {restarting && (
        <div role="status" className="mb-4 rounded border border-blue-200 bg-blue-50 px-3 py-2 text-sm text-blue-800">
          ⏳ バックエンドを再起動しています…（数秒）。戻ったら自動で表示を更新します。
        </div>
      )}
      {notice && <NoticeBox notice={notice} />}
      {data.fileChanged && !restarting && (
        <div role="alert" className="mb-4 flex flex-wrap items-center gap-2 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          <span>⚠️ 設定ファイル（.env）が、起動したときの内容から書き換えられています。下の表示は<b>まだ反映前</b>の値です。</span>
          <button type="button" onClick={() => void reflect()} className="rounded bg-amber-600 px-3 py-1 text-xs font-bold text-white">
            今すぐ反映
          </button>
        </div>
      )}
      {!data.passwordConfigured && (
        <div className="mb-4 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm text-amber-800">
          管理パスワードが未設定のため、画面からは変更できません。サーバーで <code>./factoreye.sh set-password</code> を実行するか、
          <code>.env</code> を直接編集してください。
        </div>
      )}

      <ReflectBox disabled={restarting || editing || !data.passwordConfigured} onReflect={() => void reflect()} />

      <SettingsForm
        current={data}
        form={form}
        newKey={newKey}
        onChange={setForm}
        onGenerateKey={() => setNewKey(generateIngestKey())}
      />

      <div className="mt-4 flex gap-2">
        {editing ? (
          <>
            <button type="button" onClick={() => void save()} className="rounded bg-blue-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-blue-700">
              保存して再起動
            </button>
            <button type="button" onClick={stopEditing} className="rounded border border-gray-300 bg-white px-4 py-1.5 text-sm">
              キャンセル
            </button>
          </>
        ) : (
          <button
            type="button"
            disabled={!data.passwordConfigured || restarting}
            onClick={() => (isUnlockValid(unlock) ? startEditing() : setAskPassword(true))}
            className="rounded bg-blue-600 px-4 py-1.5 text-sm font-bold text-white hover:bg-blue-700 disabled:opacity-40"
          >
            変更する
          </button>
        )}
      </div>

      {editing && <PasswordChange onChange={(password) => void changePassword(password)} />}

      {askPassword && (
        <UnlockDialog
          onCancel={() => setAskPassword(false)}
          onUnlocked={(result) => {
            setUnlock({ token: result.token, expiresAt: Date.now() + result.expiresInSeconds * 1000 });
            setAskPassword(false);
            startEditing();
          }}
        />
      )}
    </div>
  );
}

function NoticeBox({ notice }: { notice: Notice }) {
  const color = notice.kind === "ok" ? "border-green-200 bg-green-50 text-green-800" : "border-red-200 bg-red-50 text-red-800";
  return (
    <div role={notice.kind === "ok" ? "status" : "alert"} className={`mb-4 rounded border px-3 py-2 text-sm ${color}`}>
      {notice.kind === "ok" ? "✅ " : "❌ "}
      {notice.text}
      {notice.lines && notice.lines.length > 0 && (
        <ul className="ml-5 mt-1 list-disc">
          {notice.lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** 「.env を直接編集したとき」の説明と、反映ボタン。 */
function ReflectBox({ disabled, onReflect }: { disabled: boolean; onReflect: () => void }) {
  return (
    <div className="mb-4 rounded border border-gray-200 bg-white p-3 text-sm">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <b>📄 設定ファイル（.env）を直接編集したとき</b>
          <p className="text-xs text-gray-500">
            ファイルを保存したあと、このボタンで反映します（パスワード不要。バックエンドが再起動します）。その前に内容を検査し、誤りがあれば再起動しません。
          </p>
        </div>
        <button
          type="button"
          disabled={disabled}
          onClick={onReflect}
          className="rounded border border-blue-600 bg-white px-3 py-1.5 text-sm font-bold text-blue-700 disabled:opacity-40"
        >
          ファイルの内容を反映
        </button>
      </div>
    </div>
  );
}

/** 設定の入力欄。form が null の間は、サーバーの今の値を、入力できない状態で表示する。 */
function SettingsForm({
  current,
  form,
  newKey,
  onChange,
  onGenerateKey,
}: {
  current: RuntimeSettings;
  form: RuntimeForm | null;
  newKey: string | null;
  onChange: (form: RuntimeForm) => void;
  onGenerateKey: () => void;
}) {
  const editing = form !== null;
  const values = form ?? toForm(current);
  const update = (patch: Partial<RuntimeForm>) => onChange({ ...values, ...patch });

  return (
    <div className="max-w-2xl space-y-4">
      <div className="rounded border border-gray-200 bg-white p-3">
        <label htmlFor="runtime-ingest-key" className="block text-sm font-bold">
          🔑 取り込みキー（INGEST_API_KEY）
        </label>
        <p className="mb-1 text-xs text-gray-500">機器が値を送るときの合言葉（X-API-Key ヘッダー）。長い乱数にしておきます。</p>
        <div className="flex gap-2">
          <input
            id="runtime-ingest-key"
            readOnly
            value={newKey ?? (current.ingestApiKeyConfigured ? "••••••••••••••••••••••••（設定済み）" : "（未設定）")}
            className="block w-full rounded border border-gray-300 bg-gray-100 px-2 py-1.5 font-mono text-sm text-gray-500"
          />
          {editing && (
            <button type="button" onClick={onGenerateKey} className="rounded border border-gray-300 bg-white px-3 text-sm">
              新しく作る
            </button>
          )}
        </div>
        {newKey && (
          <p className="mt-1 text-xs text-amber-700">
            保存すると、キーを入れている機器すべてを書き直すまで、取り込みが 401 になります。保存後はこのキーを表示できないので、先に控えてください。
          </p>
        )}
      </div>

      <fieldset disabled={!editing} className="rounded border border-gray-200 bg-white p-3">
        <legend className="px-1 text-sm font-bold">取り込みの認証（INGEST_AUTH）</legend>
        <label className="flex items-start gap-2 text-sm">
          <input type="radio" name="ingest-auth" checked={values.ingestAuth === "key"} onChange={() => update({ ingestAuth: "key" })} className="mt-1" />
          <span>
            <b>key</b>（既定）: 上のキーが必要
          </span>
        </label>
        <label className="mt-1 flex items-start gap-2 text-sm">
          <input type="radio" name="ingest-auth" checked={values.ingestAuth === "off"} onChange={() => update({ ingestAuth: "off" })} className="mt-1" />
          <span>
            <b>off</b>: キーなしで受け付ける。
            <span className="text-amber-700">取り込みの口を LAN などに限定した運用だけで使ってください</span>
          </span>
        </label>
      </fieldset>

      <fieldset disabled={!editing} className="space-y-3 rounded border border-gray-200 bg-gray-50 p-3 text-sm">
        <div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={values.ingestAutoCreate} onChange={(e) => update({ ingestAutoCreate: e.target.checked })} className="h-4 w-4" />
            未登録のセンサー ID が来たら、自動でセンサーを作る（INGEST_AUTO_CREATE）
          </label>
          <div className="ml-6 mt-1 flex items-center gap-2 text-gray-600">
            <label htmlFor="runtime-max-sensors">作る数の上限:</label>
            <input
              id="runtime-max-sensors"
              type="number"
              min={1}
              value={values.ingestAutoCreateMaxSensors}
              onChange={(e) => update({ ingestAutoCreateMaxSensors: e.target.value })}
              className="w-24 rounded border border-gray-300 px-2 py-1 disabled:bg-gray-100"
            />
            <span>個</span>
          </div>
          <p className="ml-6 text-xs text-gray-400">打ち間違いの ID でもセンサーができます。機器の追加のたびに画面で登録しなくてよくなります。</p>
        </div>
        <div>
          <label className="flex items-center gap-2">
            <input type="checkbox" checked={values.ingestDeviceTime} onChange={(e) => update({ ingestDeviceTime: e.target.checked })} className="h-4 w-4" />
            機器が付けた測定時刻を使う（INGEST_DEVICE_TIME）
          </label>
          <p className="ml-6 text-xs text-gray-400">機器の時計が NTP で合っているときだけ。オフなら受信した時刻で保存します。</p>
        </div>
        <div>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={values.webhookAllowPrivateNetworks}
              onChange={(e) => update({ webhookAllowPrivateNetworks: e.target.checked })}
              className="h-4 w-4"
            />
            Webhook の送信先に社内ネットワークを許可する（WEBHOOK_ALLOW_PRIVATE_NETWORKS）
          </label>
          <p className="ml-6 text-xs text-gray-400">社内 LAN の n8n などへ送るときだけオンにします（http・プライベート IP）。</p>
        </div>
      </fieldset>

      <fieldset disabled={!editing} className="grid gap-3 rounded border border-gray-200 bg-white p-3 text-sm sm:grid-cols-2">
        <label className="block">
          取り込みの上限（INGEST_RATE_LIMIT）
          <input value={values.ingestRateLimit} onChange={(e) => update({ ingestRateLimit: e.target.value })} className={inputClass} />
          <span className="text-xs text-gray-400">同じ接続元から。例: 100/minute、off で解除</span>
        </label>
        <label className="block">
          照合を覚えておく秒数（INGEST_CACHE_SECONDS）
          <input type="number" min={0} value={values.ingestCacheSeconds} onChange={(e) => update({ ingestCacheSeconds: e.target.value })} className={inputClass} />
          <span className="text-xs text-gray-400">0 で無効。多数の機器が 1 秒ごとに送るときに負荷が下がります</span>
        </label>
      </fieldset>

      <fieldset disabled={!editing} className="rounded border border-gray-200 bg-white p-3 text-sm">
        <label className="block font-bold">
          画面のアドレス（FRONTEND_URL）
          <input type="url" value={values.frontendUrl} onChange={(e) => update({ frontendUrl: e.target.value })} className={`${inputClass} font-normal`} />
        </label>
      </fieldset>

      <p className="text-xs text-gray-400">
        🔒 JWT_SECRET・データベースのパスワードは、安全のためこの画面には表示も変更もできません（<code>.env</code> を直接編集してください）。
      </p>
    </div>
  );
}

/** 管理パスワードの変更（編集中だけ出す）。 */
function PasswordChange({ onChange }: { onChange: (password: string) => void }) {
  const [open, setOpen] = useState(false);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="mt-4 text-xs text-blue-700 underline">
        管理パスワードを変える
      </button>
    );
  }
  const valid = password.length >= 6 && password === confirm;
  return (
    <div className="mt-4 max-w-sm rounded border border-gray-200 bg-white p-3 text-sm">
      <b>管理パスワードを変える</b>
      <label className="mt-2 block">
        新しいパスワード（6 文字以上）
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} className={inputClass} />
      </label>
      <label className="mt-2 block">
        もう一度
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputClass} />
      </label>
      <button
        type="button"
        disabled={!valid}
        onClick={() => onChange(password)}
        className="mt-3 rounded bg-blue-600 px-3 py-1 text-sm font-bold text-white disabled:opacity-40"
      >
        パスワードを変更して再起動
      </button>
    </div>
  );
}

/** 管理パスワードの入力ダイアログ。成功したら許可証を渡す。 */
function UnlockDialog({
  onCancel,
  onUnlocked,
}: {
  onCancel: () => void;
  onUnlocked: (result: { token: string; expiresInSeconds: number }) => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);

  const submit = async () => {
    try {
      onUnlocked(await unlockRuntimeSettings(password));
    } catch (e) {
      const status = errorStatus(e);
      if (status === 401) setError("パスワードが違います。");
      else if (status === 429) setError("失敗が続いたため、しばらく待ってからやり直してください。");
      else setError(describeActionError(e, "パスワードの確認"));
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40">
      <form
        role="dialog"
        aria-label="管理パスワード"
        className="w-80 rounded-lg bg-white p-4 shadow-xl"
        onSubmit={(e) => {
          e.preventDefault();
          void submit();
        }}
      >
        <h3 className="mb-2 font-bold">管理パスワード</h3>
        <p className="mb-2 text-xs text-gray-500">設定を変えるには、管理パスワードが必要です（30 分間は入力不要）。</p>
        <input
          type="password"
          autoFocus
          aria-label="管理パスワード"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
          className="mb-1 block w-full rounded border border-gray-300 px-2 py-1.5 text-sm"
        />
        {error && (
          <p role="alert" className="mb-1 text-xs text-red-600">
            {error}
          </p>
        )}
        <p className="mb-3 text-xs text-gray-400">
          忘れたとき: サーバーで <code>./factoreye.sh set-password</code>
        </p>
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded border px-3 py-1 text-sm">
            キャンセル
          </button>
          <button type="submit" disabled={password === ""} className="rounded bg-blue-600 px-3 py-1 text-sm text-white disabled:opacity-40">
            開く
          </button>
        </div>
      </form>
    </div>
  );
}
