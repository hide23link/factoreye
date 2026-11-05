import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { BackupSettingsPanel } from "./BackupSettingsPanel";

describe("BackupSettingsPanel", () => {
  // テストの環境では VITE_RECOVERY_URL を設定しない（未設定の案内が出る）
  it("VITE_RECOVERY_URL が無いときは、URL 未設定の案内を出し、リンクは出さない", () => {
    render(<BackupSettingsPanel />);
    expect(screen.queryByRole("link", { name: "復旧ツールを開く" })).toBeNull();
    expect(screen.getByText(/復旧ツールの URL が設定されていません/)).toBeTruthy();
  });
});
