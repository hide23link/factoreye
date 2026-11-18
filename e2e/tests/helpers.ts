import type { APIRequestContext } from "@playwright/test";
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// 既定は docker-compose の backend。別のポートで動かすとき（手元の確認）は環境変数 BACKEND_URL で変える
export const BACKEND_URL = process.env.BACKEND_URL ?? "http://localhost:8000";
// docker-compose.yml / backend/app/config.py 双方のデフォルト値（.envで上書きしない限り一致する）
const INGEST_API_KEY = process.env.INGEST_API_KEY ?? "change-this-in-production";

// 実機やWizardのcurlコマンドの代わりに、テストからセンサー値を送信する。
export async function sendReading(request: APIRequestContext, ingestKey: string, value: number) {
  const response = await request.post(`${BACKEND_URL}/api/ingest/readings`, {
    headers: { "X-API-Key": INGEST_API_KEY },
    data: { ingestKey, value },
  });
  if (!response.ok()) {
    throw new Error(`ingest failed: ${response.status()} ${await response.text()}`);
  }
}

/**
 * backend の alembic の最新の版（head）の ID。移行ファイルの先頭の「スキーマ版」に使う。
 * backend/alembic/versions/*.py の revision のうち、ほかの down_revision に使われていないものが head。
 * 版を足すたびにテストの直書きを直さなくて済むよう、ファイルから読む（head が 1 つでなければエラー）。
 */
export function currentAlembicHead(): string {
  const dir = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "backend", "alembic", "versions");
  const revisions: string[] = [];
  const downs = new Set<string>();
  for (const file of readdirSync(dir).filter((name) => name.endsWith(".py"))) {
    const text = readFileSync(join(dir, file), "utf8");
    const revision = text.match(/^revision(?::\s*str)?\s*=\s*['"]([^'"]+)['"]/m)?.[1];
    if (revision) revisions.push(revision);
    // down_revision は、文字（直前の版）か None。タプル（合流）のときは、中の文字をすべて拾う
    const down = text.match(/^down_revision[^=]*=\s*(.+)$/m)?.[1] ?? "";
    for (const id of down.matchAll(/['"]([^'"]+)['"]/g)) downs.add(id[1]);
  }
  const heads = revisions.filter((revision) => !downs.has(revision));
  if (heads.length !== 1) throw new Error(`alembic の head が 1 つではありません: ${heads.join(", ")}`);
  return heads[0];
}
