import { beforeEach, describe, expect, it, vi } from "vitest";

// API_BASE_URL は、画面の起動時に VITE_API_URL から決まる値。試験ごとに差し替えられるよう、変えられる入れ物にする
const apiBase = vi.hoisted(() => ({ value: "http://api.example.test:8000" }));
vi.mock("./api", () => ({
  get API_BASE_URL() {
    return apiBase.value;
  },
}));

import { ingestSnippets, serverBaseUrl } from "./ingest-snippets";

beforeEach(() => {
  apiBase.value = "http://api.example.test:8000";
});

describe("ingestSnippets（送信コードの例）", () => {
  it("VITE_API_URL があれば、そのアドレスを埋め込む", () => {
    const snippets = ingestSnippets("demo-key");
    expect(serverBaseUrl()).toBe("http://api.example.test:8000");
    expect(snippets.curl).toContain("curl -X POST http://api.example.test:8000/api/ingest/readings");
    expect(snippets.curl).toContain('"ingestKey": "demo-key"');
    expect(snippets.arduino).toContain('"http://api.example.test:8000"');
    expect(snippets.python).toContain('"http://api.example.test:8000"');
  });

  it("VITE_API_URL が空（本番・ラズパイ）なら、画面を開いているアドレス（origin）を埋め込む。相対パスにしない", () => {
    apiBase.value = "";
    const snippets = ingestSnippets("demo-key");
    expect(serverBaseUrl()).toBe(window.location.origin);
    expect(snippets.curl).toContain(`curl -X POST ${window.location.origin}/api/ingest/readings`);
    expect(snippets.curl).not.toMatch(/POST \/api\//);
    expect(snippets.arduino).toContain(`"${window.location.origin}"`);
    expect(snippets.python).toContain(`"${window.location.origin}"`);
  });
});
