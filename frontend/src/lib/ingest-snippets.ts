/**
 * センサーにデータを送るコードの例（curl・Arduino・Python）。
 * ingestKey とセンサーの値（42.0）を埋め込んで、そのまま実行できる形にする。
 * API キーは、利用者が自分の .env の値に置き換える（ここには書かない）。
 *
 * 【誰が使うか】SetupWizard（セットアップガイド）、SensorConnectGuide（センサー登録のあとの「つなぎ方」）。
 */
import { API_BASE_URL } from "./api";

export type CodeTab = "curl" | "arduino" | "python";

export const CODE_TABS: { value: CodeTab; label: string }[] = [
  { value: "curl", label: "curl" },
  { value: "arduino", label: "Arduino (M5Stack)" },
  { value: "python", label: "Python (Raspberry Pi)" },
];

export function ingestSnippets(ingestKey: string): Record<CodeTab, string> {
  return {
    curl: `curl -X POST ${API_BASE_URL}/api/ingest/readings \\\n  -H "X-API-Key: <.envのINGEST_API_KEY>" \\\n  -H "Content-Type: application/json" \\\n  -d '{"ingestKey": "${ingestKey}", "value": 42.0}'`,
    arduino: `// clients/arduino-m5stack/ のFactorEyeClientライブラリを使用\n#include <FactorEyeClient.h>\n#include <WiFi.h>\n\nFactorEyeClient factoreye;\n\nvoid setup() {\n  WiFi.begin("your-wifi-ssid", "your-wifi-password");\n  while (WiFi.status() != WL_CONNECTED) delay(500);\n\n  factoreye.begin(\n    "${API_BASE_URL}",\n    "<.envのINGEST_API_KEY>"\n  );\n}\n\nvoid loop() {\n  factoreye.send("${ingestKey}", 42.0);\n  delay(10000);\n}`,
    python: `# clients/raspberry-pi/factoreye_client.py を使用（追加ライブラリ不要）\nfrom factoreye_client import FactorEyeClient\n\nclient = FactorEyeClient(\n    "${API_BASE_URL}",\n    "<.envのINGEST_API_KEY>",\n)\nclient.send("${ingestKey}", 42.0)`,
  };
}
