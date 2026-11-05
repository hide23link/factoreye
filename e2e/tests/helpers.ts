import type { APIRequestContext } from "@playwright/test";

export const BACKEND_URL = "http://localhost:8000";
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
