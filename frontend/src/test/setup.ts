import "@testing-library/jest-dom/vitest";

// jsdom には ResizeObserver が無い。react-grid-layout（編集モードの格子）が使うため、何もしない代用を置く。
// 大きさの変化は通知されない（寸法が必要なテストは、clientWidth などを個別に差し替える）
class NoopResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
globalThis.ResizeObserver ??= NoopResizeObserver;
