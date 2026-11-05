/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** "multi_tenant" のときクラウド版認証UI を有効化する。未設定 or "disabled" は self-hosted 互換 */
  readonly VITE_AUTH_MODE?: string;
  /** 復旧ツール（tools/recovery）の画面の URL。OSS 版の設定画面の「バックアップ」に出す。未設定なら開き方だけを出す */
  readonly VITE_RECOVERY_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
