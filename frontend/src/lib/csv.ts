/**
 * CSV ファイルを作るための、画面（React）に依存しない関数。
 *
 * - 文字列の組み立て（カンマ・改行・引用符のエスケープ、BOM 付き UTF-8、行は CRLF）
 * - 時刻を JST（UTC+9）の ISO 8601 の文字にする
 * - 「センサー名_期間.csv」のファイル名を作る
 * - ブラウザに保存させる（Blob と一時的な a 要素）
 *
 * 【誰が使うか】WidgetMenu（「CSV を保存」）、lib/widget-table.ts（表の時刻の文字）。
 * 【引数】各関数の説明を参照。
 */

/** 先頭に付ける BOM（Excel が UTF-8 と判断して、日本語が文字化けしないようにする） */
export const CSV_BOM = "﻿";

/**
 * 1 つの欄を CSV の文字にする。カンマ・改行・引用符を含むときは "…" で囲み、引用符は 2 つにする。
 * 文字列の欄で、先頭が = + - @・タブ・CR のときは、先頭に「'」を付ける（Excel が式として実行しないため。
 * センサー名に「=HYPERLINK(...)」と付けられても無害になる）。数値の欄（負数は - で始まる）は、そのまま出す。
 */
export function escapeCsvField(value: string | number | null): string {
  if (value === null) return "";
  const text = typeof value === "string" && /^[=+\-@\t\r]/.test(value) ? `'${value}` : String(value);
  return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

/** 行（欄の並び）から、CSV の全文を作る。先頭に BOM、行の区切りは CRLF、最後にも改行を付ける */
export function buildCsv(rows: ReadonlyArray<ReadonlyArray<string | number | null>>): string {
  return CSV_BOM + rows.map((row) => row.map(escapeCsvField).join(",")).join("\r\n") + "\r\n";
}

const JST_OFFSET_MS = 9 * 60 * 60 * 1000;

/** ミリ秒の時刻を、JST の ISO 8601（例: 2026-11-20T14:05:00+09:00）にする */
export function toJstIso(ms: number): string {
  return `${new Date(ms + JST_OFFSET_MS).toISOString().slice(0, 19)}+09:00`;
}

/** ミリ秒の時刻を、ファイル名向けの JST の文字（例: 20261120-1405）にする */
export function toJstFileStamp(ms: number): string {
  const iso = new Date(ms + JST_OFFSET_MS).toISOString();
  return `${iso.slice(0, 10).replace(/-/g, "")}-${iso.slice(11, 16).replace(":", "")}`;
}

/** ファイル名に使えない文字（\ / : * ? " < > |）と制御文字を、「_」に替える。空になったら "data" */
function safeFileNamePart(text: string): string {
  // 使えない記号と、制御文字（文字コード 31 以下）を「_」にする
  const cleaned = Array.from(text, (ch) => (/[\\/:*?"<>|]/.test(ch) || ch.charCodeAt(0) < 32 ? "_" : ch)).join("").trim();
  return cleaned === "" ? "data" : cleaned;
}

/** 「センサー名_期間.csv」のファイル名を作る（name = センサー名など、period = 「直近1時間」など） */
export function csvFileName(name: string, period: string): string {
  // 長すぎる名前は切る（OS のファイル名の上限に当たらないように）
  return `${safeFileNamePart(name).slice(0, 80)}_${safeFileNamePart(period)}.csv`;
}

/** CSV の文字を、ファイルとしてブラウザに保存させる（画面の通常の Web 画面でだけ使える） */
export function downloadCsv(fileName: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = fileName;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // 保存の開始を待ってから解放する
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
