import { describe, expect, it } from "vitest";

import { render, screen } from "../test/test-utils";
import { LegalPage } from "./LegalPage";

describe("LegalPage", () => {
  it("プライバシーポリシーを、草案の注意つきで表示する", () => {
    render(<LegalPage kind="privacy" />);

    expect(screen.getByRole("heading", { level: 1, name: "プライバシーポリシー" })).toBeInTheDocument();
    expect(screen.getByText(/草案です/)).toBeInTheDocument();
    expect(screen.getByText("4. 運営者による閲覧（重要）")).toBeInTheDocument();
  });

  it("利用規約は、準備中の表示になる", () => {
    render(<LegalPage kind="terms" />);

    expect(screen.getByRole("heading", { level: 1, name: "利用規約" })).toBeInTheDocument();
    expect(screen.getByText(/準備中/)).toBeInTheDocument();
  });
});
