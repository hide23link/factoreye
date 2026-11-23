/**
 * SaaS 版の入口の画面。「新規登録」と「ログイン」の 2 つのタブを持つ。パスワードは使わない。
 *
 * - 新規登録: メールアドレスだけを入れる。確認メールのリンクを開くと、この端末にパスキーを登録して
 *   使い始められる（リンクの画面は LinkLanding.tsx）。
 * - ログイン: 「パスキーでログイン」を押すだけ（アドレスは聞かない。端末の選択画面でアカウントを選ぶ）。
 *   パスキーが使えない端末は「メールでログイン」（15 分・1 回のログインリンク）、端末を失くしたときは
 *   「メールで再登録」（1 時間のリンクで新しい端末を登録）。
 * - メールの依頼の応答は、アドレスが登録済みかどうかに関わらず、同じ文言を出す。
 * 成功するとトークンを保存し、利用者の情報を読み込んでから、画面の本体へ進む（App.tsx が切り替える）。
 * グラフのリンク（?dashboard=…&graph=…）から来たときは、ログインのタブで開き、
 * 「ログインすると、リンクのグラフを開きます」と出す。URL はそのまま残るので、ログインした後に
 * App.tsx がリンクの画面を開く。
 * self-hosted では表示されない（App.tsx で SaaS のときだけ使う）。
 *
 * 【誰が使うか】App.tsx が、SaaS 版でログインしていないときに出す。
 * 【引数（props）】onAuthenticated = ログインに成功したときに呼ぶ処理。
 */
import { useState } from "react";

import {
  beginPasskeyLogin,
  fetchMe,
  finishPasskeyLogin,
  requestEmailLink,
  requestLoginLink,
} from "../../lib/api";
import { clearAuthLinkFromUrl, parseAuthLinkHash } from "../../lib/auth-link";
import { describeAuthError } from "../../lib/errors";
import { readGraphLinkFromUrl } from "../../lib/graph-link";
import { PasskeyCancelledError, getPasskey, isPasskeySupported } from "../../lib/passkey";
import { useAuthStore } from "../../store/useAuthStore";
import { LinkLanding } from "./LinkLanding";

// 画面のタブ（ログイン・新規登録）
type Tab = "login" | "register";
// ログインのタブの中の画面。passkey=パスキーでログイン、emailLogin=メールでログイン、recover=端末の再登録
type LoginMode = "passkey" | "emailLogin" | "recover";

const INPUT_CLASS =
  "w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500";
const PRIMARY_BUTTON_CLASS =
  "w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50";
const LINK_BUTTON_CLASS = "text-sm text-blue-600 hover:underline";

/**
 * メールのリンクを送ってもらうフォーム（アドレス → 送信）。送ったあとは、どのアドレスでも同じ文言を出す。
 * 登録・メールでログイン・端末の再登録で使い回す。
 */
function EmailLinkForm({
  idPrefix,
  submitLabel,
  sentMessage,
  send,
  action,
}: {
  idPrefix: string;
  submitLabel: string;
  sentMessage: (email: string) => string;
  send: (email: string) => Promise<unknown>;
  action: "request" | "link";
}) {
  const [email, setEmail] = useState("");
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      await send(email.trim());
      setSentTo(email.trim());
    } catch (err) {
      setError(describeAuthError(err, action));
    } finally {
      setLoading(false);
    }
  };

  if (sentTo !== null) {
    return (
      <div role="status" className="space-y-3 text-sm text-gray-700">
        <p className="rounded-md bg-green-50 px-3 py-2 text-green-800">{sentMessage(sentTo)}</p>
        <p className="text-xs text-gray-500">
          届かないときは、迷惑メールのフォルダも見てください。同じアドレスへは、1 時間に 3 通まで送れます。
        </p>
      </div>
    );
  }

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label htmlFor={`${idPrefix}-email`} className="mb-1 block text-sm font-medium text-gray-700">
          メールアドレス
        </label>
        <input
          id={`${idPrefix}-email`}
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className={INPUT_CLASS}
          placeholder="you@example.com"
          autoComplete="email"
        />
      </div>
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button type="submit" disabled={loading} className={PRIMARY_BUTTON_CLASS}>
        {loading ? "送信中..." : submitLabel}
      </button>
    </form>
  );
}

/** 新規登録: メールアドレスだけ。確認メールを送る。 */
function RegisterForm() {
  return (
    <div className="space-y-4">
      <EmailLinkForm
        idPrefix="reg"
        submitLabel="確認メールを送る"
        action="request"
        send={requestEmailLink}
        sentMessage={(email) =>
          `${email} に確認メールを送りました。24 時間以内にリンクを開いてください。`
        }
      />
      <p className="text-center text-xs text-gray-500">センサー10個まで永続無料</p>
    </div>
  );
}

/** ログイン: パスキーを押すだけ。使えないときの代わりの入口（メール・再登録）も出す。 */
function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [mode, setMode] = useState<LoginMode>("passkey");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);

  // パスキーでログイン: 端末の確認画面（アカウントの選択・指紋・顔・PIN）を出して、署名を送る
  const handlePasskeyLogin = async () => {
    setError(null);
    setLoading(true);
    try {
      const begin = await beginPasskeyLogin();
      const credential = await getPasskey(begin.options);
      const tokens = await finishPasskeyLogin({ challengeId: begin.challengeId, credential });
      const me = await fetchMe(tokens.accessToken);
      setAuth(tokens.accessToken, tokens.refreshToken, me);
      onSuccess();
    } catch (err) {
      // 端末の画面をやめただけなら、エラーにしない
      if (!(err instanceof PasskeyCancelledError)) setError(describeAuthError(err, "login"));
    } finally {
      setLoading(false);
    }
  };

  if (mode === "emailLogin") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          パスキーが使えないときは、メールで届くリンク（15 分・1 回だけ）でログインできます。
          このログインでは、端末（パスキー）の追加・削除はできません。
        </p>
        <EmailLinkForm
          idPrefix="mail-login"
          submitLabel="ログインのリンクを送る"
          action="request"
          send={requestLoginLink}
          sentMessage={() =>
            "登録されているアドレスなら、ログインのリンクを送りました。15 分以内に開いてください。"
          }
        />
        <button type="button" onClick={() => setMode("passkey")} className={LINK_BUTTON_CLASS}>
          パスキーでログインに戻る
        </button>
      </div>
    );
  }

  if (mode === "recover") {
    return (
      <div className="space-y-4">
        <p className="text-sm text-gray-600">
          端末を失くした・機種変更したときは、メールで届くリンク（1 時間・1 回だけ）から、新しい端末にパスキーを登録できます。
        </p>
        <EmailLinkForm
          idPrefix="recover"
          submitLabel="再登録のメールを送る"
          action="request"
          send={requestEmailLink}
          sentMessage={() =>
            "登録されているアドレスなら、メールを送りました。1 時間以内にリンクを開いてください。"
          }
        />
        <button type="button" onClick={() => setMode("passkey")} className={LINK_BUTTON_CLASS}>
          パスキーでログインに戻る
        </button>
      </div>
    );
  }

  const supported = isPasskeySupported();
  return (
    <div className="space-y-4">
      {!supported && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          この端末・ブラウザは、パスキーに対応していません。下の「メールでログイン」を使うか、新しいブラウザで開いてください。
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={loading || !supported}
        onClick={() => void handlePasskeyLogin()}
        className={PRIMARY_BUTTON_CLASS}
      >
        {loading ? "確認しています..." : "パスキーでログイン"}
      </button>
      <ul className="space-y-2 text-center">
        <li>
          <button type="button" onClick={() => setMode("emailLogin")} className={LINK_BUTTON_CLASS}>
            パスキーが使えない・メールでログイン
          </button>
        </li>
        <li>
          <button type="button" onClick={() => setMode("recover")} className={LINK_BUTTON_CLASS}>
            端末を失くした・パスキーがない
          </button>
        </li>
      </ul>
    </div>
  );
}

// 親から受け取る値: 認証が済んだときに呼ぶ関数
interface LoginPageProps {
  onAuthenticated: () => void;
}

/** ログイン・新規登録の画面（タブで切り替える）。メールのリンクで開かれたときは、リンクの画面を出す。 */
export function LoginPage({ onAuthenticated }: LoginPageProps) {
  // メールのリンク（# 以降）で開かれたか。使い終えたら、ログイン画面に戻る
  const [authLink, setAuthLink] = useState(() => parseAuthLinkHash(window.location.hash));
  // グラフのリンクから来た人は登録済みのはずなので、ログインのタブから始める
  const [fromLink] = useState(() => readGraphLinkFromUrl().kind === "link");
  const [tab, setTab] = useState<Tab>(fromLink ? "login" : "register");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* ロゴ */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">FactorEye</h1>
          <p className="mt-2 text-sm text-gray-500">工場監視をゼロ円で始める</p>
        </div>

        <div className="rounded-xl bg-white px-8 py-8 shadow-sm ring-1 ring-gray-200">
          {authLink ? (
            <LinkLanding
              link={authLink}
              onBack={() => {
                clearAuthLinkFromUrl();
                setAuthLink(null);
                setTab("login");
              }}
            />
          ) : (
            <>
              {/* タブ */}
              <div className="mb-6 flex rounded-lg bg-gray-100 p-1">
                {(["register", "login"] as Tab[]).map((t) => (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setTab(t)}
                    className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                      tab === t ? "bg-white text-gray-900 shadow-sm" : "text-gray-500 hover:text-gray-700"
                    }`}
                  >
                    {t === "register" ? "新規登録" : "ログイン"}
                  </button>
                ))}
              </div>

              {fromLink && (
                <p role="status" className="mb-4 rounded-md bg-blue-50 px-3 py-2 text-sm text-blue-700">
                  ログインすると、リンクのグラフを開きます
                </p>
              )}
              {tab === "login" ? <LoginForm onSuccess={onAuthenticated} /> : <RegisterForm />}
            </>
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-500">
          セルフホストで使いたい方は
          <a
            href="https://github.com/hide23link/factoreye"
            target="_blank"
            rel="noopener noreferrer"
            className="ml-1 text-blue-500 hover:underline"
          >
            GitHub
          </a>
          からどうぞ
        </p>
      </div>
    </div>
  );
}
