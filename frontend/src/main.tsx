import { QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";

import App from "./App";
import { AdminApp } from "./components/admin/AdminApp";
import "./index.css";
import { queryClient } from "./queryClient";

const rootElement = document.getElementById("root");
if (!rootElement) {
  throw new Error("#root element not found");
}

// ルーターは使わず、/admin 配下だけ管理者画面に分ける（通常画面の状態管理に影響させない）
const isAdminPath = window.location.pathname === "/admin" || window.location.pathname.startsWith("/admin/");

createRoot(rootElement).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      {isAdminPath ? <AdminApp /> : <App />}
    </QueryClientProvider>
  </StrictMode>,
);
