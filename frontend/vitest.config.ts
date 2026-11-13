import react from "@vitejs/plugin-react";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
    globals: true,
    setupFiles: ["./src/test/setup.ts"],
    css: false,
    coverage: {
      provider: "v8",
      all: true,
      include: ["src/**/*.{ts,tsx}"],
      reporter: ["text", "html", "json-summary"],
      exclude: ["src/test/**", "src/main.tsx", "**/*.d.ts", "**/*.config.*"],
      thresholds: {
        // 2026-11-11 時点の実測（stmt 85.7 / branch 82.4 / func 79.3 / line 87.2）より少し下に置き、低下を防ぐ
        lines: 80,
        functions: 75,
        branches: 75,
        statements: 80,
      },
    },
  },
});
