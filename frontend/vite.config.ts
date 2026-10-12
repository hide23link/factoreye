import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
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
    allowedHosts: ["factoreye.hide23.link"],
  },
});
