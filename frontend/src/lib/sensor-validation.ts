/**
 * センサーの入力（名前・単位・しきい値）の検証。画面に依存しない純粋な関数。
 * サーバーに送る前に見つけて、日本語で理由を返す（サーバーの 422 の英語の文を、利用者に見せないため）。
 *
 * 【誰が使うか】SensorSettingsPanel（作成・編集）、SetupWizard。
 */

/** 名前・単位（・取り込みキー）が空でないか。問題があれば理由、なければ null */
export function validateSensorBasics(input: { name: string; unit: string; ingestKey?: string }): string | null {
  if (input.name.trim() === "") return "名前を入力してください。";
  if (input.ingestKey !== undefined && input.ingestKey.trim() === "") return "Ingest Key を入力してください。";
  if (input.unit.trim() === "") return "単位を選んでください（候補に無ければ「その他」で入力できます）。";
  return null;
}

/**
 * しきい値の大小が合っているか。
 * 重故障の下限 ≤ 軽故障の下限 ≤ 軽故障の上限 ≤ 重故障の上限 の順に並ぶこと（設定した項目だけを見る）。
 * 逆転していると、アラームが出続ける・出ない、といった誤動作になる。
 */
export function validateThresholds(t: {
  minCritical: number | null;
  minWarning: number | null;
  maxWarning: number | null;
  maxCritical: number | null;
}): string | null {
  const ordered = [t.minCritical, t.minWarning, t.maxWarning, t.maxCritical].filter((v): v is number => v !== null);
  for (let i = 1; i < ordered.length; i += 1) {
    if (ordered[i] < ordered[i - 1]) {
      return "しきい値の大小が合っていません（重故障の下限 ≤ 軽故障の下限 ≤ 軽故障の上限 ≤ 重故障の上限 の順にしてください）。";
    }
  }
  return null;
}
