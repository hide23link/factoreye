/**
 * SaaS 版の入口の画面。「新規登録」と「ログイン」の2つのタブを持つ。
 * 成功するとトークンを保存し、利用者の情報を読み込んでから、画面の本体へ進む。
 * self-hosted では表示されない（App.tsx で SaaS のときだけ使う）。
 *
 * 【誰が使うか】App.tsx が、SaaS 版でログインしていないときに出す。
 * 【引数（props）】onAuthenticated = ログイン・登録に成功したときに呼ぶ処理。
 */
import { useState } from "react";

import { fetchMe, loginUser, registerUser } from "../../lib/api";
import { describeAuthError } from "../../lib/errors";
import { useAuthStore } from "../../store/useAuthStore";

// 画面のタブ（ログイン・新規登録）
type Tab = "login" | "register";

/** ログインのフォーム（メールとパスワード）。 */
function LoginForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);

  // 送信: ログインして、トークンと利用者の情報を保存する。失敗したら理由を表示する
  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await loginUser({ email, password });
      const me = await fetchMe(tokens.accessToken);
      setAuth(tokens.accessToken, tokens.refreshToken, me);
      onSuccess();
    } catch (err) {
      setError(describeAuthError(err, "login"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label htmlFor="login-email" className="block text-sm font-medium text-gray-700 mb-1">
          メールアドレス
        </label>
        <input
          id="login-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="you@example.com"
          autoComplete="email"
        />
      </div>
      <div>
        <label htmlFor="login-password" className="block text-sm font-medium text-gray-700 mb-1">
          パスワード
        </label>
        <input
          id="login-password"
          type="password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="••••••••"
          autoComplete="current-password"
        />
      </div>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "ログイン中..." : "ログイン"}
      </button>
    </form>
  );
}

/** 新規登録のフォーム（メール・パスワード・ワークスペースの名前）。登録と同時にログインする。 */
function RegisterForm({ onSuccess }: { onSuccess: () => void }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [workspaceName, setWorkspaceName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const setAuth = useAuthStore((s) => s.setAuth);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setLoading(true);
    try {
      const tokens = await registerUser({ email, password, workspaceName });
      const me = await fetchMe(tokens.accessToken);
      setAuth(tokens.accessToken, tokens.refreshToken, me);
      onSuccess();
    } catch (err) {
      setError(describeAuthError(err, "register"));
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={(e) => void handleSubmit(e)} className="space-y-4">
      <div>
        <label htmlFor="reg-email" className="block text-sm font-medium text-gray-700 mb-1">
          メールアドレス
        </label>
        <input
          id="reg-email"
          type="email"
          required
          value={email}
          onChange={(event) => setEmail(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="you@example.com"
          autoComplete="email"
        />
      </div>
      <div>
        <label htmlFor="reg-workspace" className="block text-sm font-medium text-gray-700 mb-1">
          ワークスペース名
        </label>
        <input
          id="reg-workspace"
          type="text"
          required
          value={workspaceName}
          onChange={(event) => setWorkspaceName(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="田中工場"
        />
      </div>
      <div>
        <label htmlFor="reg-password" className="block text-sm font-medium text-gray-700 mb-1">
          パスワード
          <span className="ml-1 text-xs text-gray-400">（8文字以上）</span>
        </label>
        <input
          id="reg-password"
          type="password"
          required
          minLength={8}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
          placeholder="••••••••"
          autoComplete="new-password"
        />
      </div>
      {error && (
        <p className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p>
      )}
      <button
        type="submit"
        disabled={loading}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "登録中..." : "無料で始める"}
      </button>
      <p className="text-center text-xs text-gray-400">
        センサー10個まで永続無料
      </p>
    </form>
  );
}

// 親から受け取る値: 認証が済んだときに呼ぶ関数
interface LoginPageProps {
  onAuthenticated: () => void;
}

/** ログイン・新規登録の画面（タブで切り替える）。 */
export function LoginPage({ onAuthenticated }: LoginPageProps) {
  const [tab, setTab] = useState<Tab>("register");

  return (
    <div className="flex min-h-screen items-center justify-center bg-gray-50 px-4">
      <div className="w-full max-w-md">
        {/* ロゴ */}
        <div className="mb-8 text-center">
          <h1 className="text-3xl font-bold text-gray-900">FactorEye</h1>
          <p className="mt-2 text-sm text-gray-500">工場監視をゼロ円で始める</p>
        </div>

        <div className="rounded-xl bg-white px-8 py-8 shadow-sm ring-1 ring-gray-200">
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

          {tab === "login" ? (
            <LoginForm onSuccess={onAuthenticated} />
          ) : (
            <RegisterForm onSuccess={onAuthenticated} />
          )}
        </div>

        <p className="mt-6 text-center text-xs text-gray-400">
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
