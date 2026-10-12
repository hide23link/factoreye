import { describe, expect, it } from "vitest";

import { AdminApiError } from "./adminApi";
import {
  ApiError,
  describeActionError,
  describeAdminLoginError,
  describeAuthError,
  errorStatus,
} from "./errors";

describe("errorStatus", () => {
  it("ApiError と AdminApiError は状態コードを返し、それ以外は null", () => {
    expect(errorStatus(new ApiError(401, "x"))).toBe(401);
    expect(errorStatus(new AdminApiError(429, "x"))).toBe(429);
    expect(errorStatus(new TypeError("Failed to fetch"))).toBeNull();
  });
});

describe("describeAuthError", () => {
  it("状態コードごとに日本語の文言を返し、生のエラー文を出さない", () => {
    expect(describeAuthError(new ApiError(401, 'POST /api/auth/login failed: 401 {"detail":"x"}'), "login")).toBe(
      "メールアドレスまたはパスワードが正しくありません。",
    );
    expect(describeAuthError(new ApiError(409, "x"), "register")).toMatch(/すでに登録/);
    expect(describeAuthError(new ApiError(422, "x"), "register")).toMatch(/8文字以上、72バイト以内/);
    expect(describeAuthError(new ApiError(429, "x"), "login")).toMatch(/試行回数/);
    expect(describeAuthError(new ApiError(500, "x"), "login")).toMatch(/サーバーで問題/);
    expect(describeAuthError(new TypeError("Failed to fetch"), "login")).toMatch(/接続できませんでした/);
    expect(describeAuthError(new ApiError(401, "POST failed: 401"), "login")).not.toMatch(/POST/);
  });
});

describe("describeAdminLoginError", () => {
  it("401 だけが ID・パスワードの誤りで、それ以外は別の文言にする", () => {
    expect(describeAdminLoginError(new AdminApiError(401, "x"))).toBe("IDまたはパスワードが正しくありません。");
    expect(describeAdminLoginError(new AdminApiError(429, "x"))).toMatch(/試行回数/);
    expect(describeAdminLoginError(new AdminApiError(500, "x"))).toMatch(/サーバーで問題/);
    expect(describeAdminLoginError(new TypeError("Failed to fetch"))).toMatch(/接続できませんでした/);
  });
});

describe("describeActionError", () => {
  it("操作名を含めた文言にする", () => {
    expect(describeActionError(new ApiError(404, "x"), "ウィジェットの削除")).toMatch(/^ウィジェットの削除に失敗しました/);
    expect(describeActionError(new TypeError("x"), "保存")).toMatch(/接続できませんでした/);
  });
});
