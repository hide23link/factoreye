/**
 * メールのリンクを開いたときの画面（登録・端末の再登録・ログインリンク）。
 *
 * - 登録（register）・再登録（recover）: メールの確認ができたことを見せ、この端末にパスキーを登録してもらう。
 *   端末の名前を付けて「パスキーを登録する」を押すと、端末の確認画面（指紋・顔・PIN）が出る。
 * - ログインリンク（login）: 開くとすぐログインする。パスキーの登録は求めない
 *   （このログインでは、端末の追加・削除はできない）。
 * リンクは 1 回だけ使える。使い終えたら（失敗しても）、アドレスバーからトークンを消す。
 *
 * 【誰が使うか】LoginPage.tsx が、URL にリンクがあるときに出す。
 * 【引数（props）】link=リンクの種類とトークン、onBack=ログイン画面へ戻る処理。
 */
import { useEffect, useRef, useState } from "react";

import {
  beginPasskeyRegistration,
  fetchMe,
  finishPasskeyRegistration,
  loginWithLink,
} from "../../lib/api";
import { clearAuthLinkFromUrl, type AuthLink } from "../../lib/auth-link";
import { describeAuthError } from "../../lib/errors";
import {
  PasskeyCancelledError,
  createPasskey,
  defaultDeviceName,
  isPasskeySupported,
} from "../../lib/passkey";
import { useAuthStore } from "../../store/useAuthStore";
import type { RegisterBegin } from "../../types";

interface LinkLandingProps {
  link: AuthLink;
  onBack: () => void;
}

/** 失敗の表示（理由と、ログイン画面へ戻るボタン）。 */
function Failure({ message, onBack }: { message: string; onBack: () => void }) {
  return (
    <div className="space-y-4">
      <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
        {message}
      </p>
      <button
        type="button"
        onClick={onBack}
        className="w-full rounded-md border border-gray-300 px-4 py-2 text-sm font-medium text-gray-700 hover:bg-gray-50"
      >
        ログイン画面へ
      </button>
    </div>
  );
}

/** ログインリンク: 開いたらすぐログインする。 */
function LoginLinkLanding({ link, onBack }: LinkLandingProps) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [error, setError] = useState<string | null>(null);
  // リンクは 1 回だけ使える。開発時の二重実行（StrictMode）でも、2 回目を送らない
  const started = useRef(false);

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    void (async () => {
      try {
        const tokens = await loginWithLink(link.token);
        const me = await fetchMe(tokens.accessToken);
        clearAuthLinkFromUrl();
        setAuth(tokens.accessToken, tokens.refreshToken, me);
      } catch (err) {
        clearAuthLinkFromUrl();
        setError(describeAuthError(err, "link"));
      }
    })();
  }, [link.token, setAuth]);

  if (error) return <Failure message={error} onBack={onBack} />;
  return (
    <p role="status" className="text-center text-sm text-gray-600">
      ログインしています...
    </p>
  );
}

/** 登録・再登録: メールの確認ができたことを見せて、この端末にパスキーを登録する。 */
function RegisterLinkLanding({ link, onBack }: LinkLandingProps) {
  const setAuth = useAuthStore((s) => s.setAuth);
  const [begin, setBegin] = useState<RegisterBegin | null>(null);
  const [deviceName, setDeviceName] = useState(defaultDeviceName);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const started = useRef(false);

  // リンクのトークンを確かめる（まだ使えるか・どのアドレスか）。登録の操作までは、使い切らない
  useEffect(() => {
    if (started.current) return;
    started.current = true;
    beginPasskeyRegistration(link.token)
      .then(setBegin)
      .catch((err: unknown) => setError(describeAuthError(err, "link")));
  }, [link.token]);

  if (error && !begin) return <Failure message={error} onBack={onBack} />;
  if (!begin) {
    return (
      <p role="status" className="text-center text-sm text-gray-600">
        リンクを確認しています...
      </p>
    );
  }

  // 登録: 端末の確認画面（指紋・顔・PIN）を出して、できたパスキーをサーバーへ送る
  const handleRegister = async () => {
    setError(null);
    setLoading(true);
    try {
      const credential = await createPasskey(begin.options);
      const tokens = await finishPasskeyRegistration({
        challengeId: begin.challengeId,
        credential,
        deviceName: deviceName.trim(),
      });
      const me = await fetchMe(tokens.accessToken);
      clearAuthLinkFromUrl();
      setAuth(tokens.accessToken, tokens.refreshToken, me);
    } catch (err) {
      // 端末の画面をやめただけなら、エラーにせず、もう一度押せる状態に戻す
      if (!(err instanceof PasskeyCancelledError)) setError(describeAuthError(err, "register"));
    } finally {
      setLoading(false);
    }
  };

  const isRecover = begin.purpose === "recover";
  return (
    <div className="space-y-4">
      <p className="flex items-center gap-2 text-base font-semibold text-gray-900">
        <span aria-hidden="true" className="inline-block h-2.5 w-2.5 rounded-full bg-green-500" />
        メールアドレスを確認しました
      </p>
      <p className="text-sm text-gray-700">
        <span className="font-mono">{begin.email}</span>
      </p>
      <p className="text-sm text-gray-600">
        {isRecover
          ? "新しい端末にパスキーを登録します。登録すると、この端末でログインできます。"
          : "この端末にパスキーを登録して、使い始めましょう。次からは、パスワードなしでログインできます。"}
      </p>
      <div>
        <label htmlFor="passkey-device-name" className="mb-1 block text-sm font-medium text-gray-700">
          この端末の名前
        </label>
        <input
          id="passkey-device-name"
          type="text"
          maxLength={50}
          value={deviceName}
          onChange={(event) => setDeviceName(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:border-blue-500 focus:outline-none focus:ring-1 focus:ring-blue-500"
        />
      </div>
      {!isPasskeySupported() && (
        <p role="alert" className="rounded-md bg-amber-50 px-3 py-2 text-sm text-amber-800">
          この端末・ブラウザは、パスキーに対応していません。Safari・Chrome・Edge・Firefox の新しい版で開いてください。
        </p>
      )}
      {error && (
        <p role="alert" className="rounded-md bg-red-50 px-3 py-2 text-sm text-red-700">
          {error}
        </p>
      )}
      <button
        type="button"
        disabled={loading || !isPasskeySupported()}
        onClick={() => void handleRegister()}
        className="w-full rounded-md bg-blue-600 px-4 py-2 text-sm font-medium text-white hover:bg-blue-700 disabled:opacity-50"
      >
        {loading ? "登録中..." : "パスキーを登録する"}
      </button>
      <p className="text-xs text-gray-500">
        iCloud キーチェーン・Google パスワードマネージャー・1Password などに保存すると、同じアカウントの別の端末でも使えます。
      </p>
    </div>
  );
}

/** メールのリンクを開いたときの画面。リンクの種類で、ログインか登録かを切り替える。 */
export function LinkLanding(props: LinkLandingProps) {
  return props.link.kind === "login" ? <LoginLinkLanding {...props} /> : <RegisterLinkLanding {...props} />;
}
