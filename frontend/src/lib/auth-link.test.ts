import { afterEach, describe, expect, it } from "vitest";

import { clearAuthLinkFromUrl, parseAuthLinkHash } from "./auth-link";

describe("parseAuthLinkHash", () => {
  it("登録・再登録・ログインのリンクから、種類とトークンを取り出す", () => {
    expect(parseAuthLinkHash("#register=dummy_token_value_1")).toEqual({ kind: "register", token: "dummy_token_value_1" });
    expect(parseAuthLinkHash("#recover=dummy_token_value_1")).toEqual({ kind: "recover", token: "dummy_token_value_1" });
    expect(parseAuthLinkHash("#login=dummy_token_value_1")).toEqual({ kind: "login", token: "dummy_token_value_1" });
  });

  it("リンクでないもの・短すぎるトークン・余計な文字は null", () => {
    expect(parseAuthLinkHash("")).toBeNull();
    expect(parseAuthLinkHash("#admin")).toBeNull();
    expect(parseAuthLinkHash("#login=short")).toBeNull();
    expect(parseAuthLinkHash("#login=abcDEF123456&x=1")).toBeNull();
    expect(parseAuthLinkHash("#other=abcDEF123456")).toBeNull();
  });
});

describe("clearAuthLinkFromUrl", () => {
  afterEach(() => window.history.replaceState(null, "", "/"));

  it("# 以降（トークン）を消し、パスと検索部分は残す", () => {
    window.history.replaceState(null, "", "/?dashboard=1#login=abcDEF123456");
    clearAuthLinkFromUrl();
    expect(window.location.hash).toBe("");
    expect(window.location.search).toBe("?dashboard=1");
  });
});
