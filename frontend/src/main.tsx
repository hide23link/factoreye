/**
 * アプリの入口。React の画面を <div id="root"> に描画する。
 *
 * - 通常の画面（App）と、管理者の画面（AdminApp、/admin 配下）の2つを、URL の先頭で振り分ける
 * - 全体で1つの QueryClient（データ取得のキャッシュ）を共有する
 *
 * 【誰が・いつ呼ぶか】ブラウザが index.html を開くと、最初に実行される（自分で呼ぶことはない）。
 */
import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { ChunkErrorBoundary } from "./components/ChunkErrorBoundary";
import "./index.css";
import { lazyNamed } from "./lib/lazyWithRetry";
import { queryClient } from "./queryClient";

// 管理者画面は、/admin を開いた時だけ読み込む
const AdminApp = lazyNamed(() => import("./components/admin/AdminApp"), "AdminApp");

// index.html の <div id="root"> を探す。無ければ画面を作れないので、ここで止める
const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

// ルーターは使わず、/admin 配下だけ管理者画面に分ける（通常画面の状態管理に影響させない）
const isAdminPath = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isAdminPath ? (
        <ChunkErrorBoundary>
          <Suspense fallback={<p className="p-4 text-sm text-gray-400">読み込み中...</p>}>
            <AdminApp />
          </Suspense>
        </ChunkErrorBoundary>
      ) : (
        <App />
      )}
    </QueryClientProvider>
  </StrictMode>,
);
