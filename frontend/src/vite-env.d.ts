/// <reference types="vite/client" />

interface ImportMetaEnv {
  readonly VITE_API_URL: string;
  /** "multi_tenant" のときクラウド版認証UI を有効化する。未設定 or "disabled" は self-hosted 互換 */
  readonly VITE_AUTH_MODE?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
