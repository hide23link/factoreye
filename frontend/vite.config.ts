import react from "@vitejs/plugin-react";
import { defineConfig, loadEnv } from "vite";

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  build: {
    rollupOptions: {
      output: {
        // 変わりにくい依存を別ファイルにし、再訪時にアプリのコードだけを取り直せるようにする
        manualChunks(id) {
          if (!id.includes("node_modules")) return undefined;
          if (/node_modules\/(react|react-dom|scheduler)\//.test(id)) return "vendor-react";
          if (/node_modules\/(recharts|d3-[^/]+|victory-vendor|internmap|decimal\.js-light|es-toolkit|immer|reselect|@reduxjs|redux|react-redux|use-sync-external-store|eventemitter3|tiny-invariant|clsx)\//.test(id)) {
            return "vendor-charts";
          }
          return undefined;
        },
      },
    },
  },
  server: {
    port: 3001,
  },
  preview: {
    port: 3001,
    host: true,
    // 外から、ホスト名つきで開くときの許可（カンマ区切り。例: VITE_ALLOWED_HOSTS=factoreye.example.com）。
    // 既定は空で、localhost だけ。配布版は nginx で配信するので、この preview は開発用
    allowedHosts: loadEnv(mode, ".", "VITE_")
      .VITE_ALLOWED_HOSTS?.split(",")
      .map((host) => host.trim())
      .filter(Boolean) ?? [],
  },
}));
