// 設定画面の HTML（スマホで表示する）。SetupPortal.cpp が / で返す。
// 見た目はモックアップ（WiFi の設定画面・センサーノードの設定画面）に合わせている。
// %TITLE%・%AP_NAME%・%AP_ADDRESS% は、返す前に SetupPortal.cpp が置き換える。
// アプリ独自の項目は /fields から受け取り、画面で組み立てる。呼ぶ URL は SetupPortal.h の冒頭を参照。
// 外部の CSS・JS・フォントは読み込まない（インターネットにつながっていないため）。
#pragma once
#include <Arduino.h>

static const char SETUP_PAGE_HTML[] PROGMEM = R"HTML(<!doctype html>
<html lang="ja"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>%TITLE%</title>
<style>
body{font-family:sans-serif;margin:0;padding:24px 16px;background:#f3f4f1;color:#1d2125}
h1{font-size:22px;margin:0}
.sub{font-family:monospace;font-size:12px;color:#5b636b;margin:2px 0 12px}
.card{background:#fff;border:1px solid #dfe2dc;border-radius:12px;padding:14px;margin-bottom:12px;display:flex;flex-direction:column;gap:6px}
.head{display:flex;justify-content:space-between;align-items:center;font-size:15px;font-weight:bold}
.head small{font-weight:normal;font-size:12px;color:#5b636b}
.net{display:flex;justify-content:space-between;align-items:center;width:100%;min-height:48px;padding:0 10px;border:none;border-bottom:1px solid #eceee9;border-radius:6px;background:transparent;font:inherit;font-size:15px;color:#1d2125;text-align:left}
.net.selected{background:#dceaff}
.net .name{display:flex;align-items:center;gap:8px}
.net .level{font-size:13px;color:#5b636b}
label{font-size:13px;color:#3a4148}
input[type=text],input[type=password],select{min-height:44px;box-sizing:border-box;padding:0 12px;font-size:16px;border:1px solid #c9cdc5;border-radius:8px;background:#fff;font-family:inherit}
input.mono{font-family:monospace}
input:focus,select:focus,button:focus-visible{outline:2px solid #1565c0;outline-offset:1px}
.show{display:flex;align-items:center;gap:8px;font-size:14px;min-height:44px;color:#1d2125}
.choice{display:flex;align-items:center;gap:10px;min-height:48px;padding:0 10px;border-radius:8px;font-size:15px;color:#1d2125}
.choice.on{background:#dceaff}
.choice small{display:block;font-size:13px;color:#5b636b}
.field{display:flex;flex-direction:column;gap:6px;margin-top:6px}
.help{font-size:12px;color:#5b636b;line-height:1.6}
.indent{display:flex;flex-direction:column;gap:6px;padding:4px 0 0 4px}
button.main{min-height:52px;margin:6px 0 12px;width:100%;border:none;border-radius:8px;font-size:16px;font-weight:bold;color:#fff;background:#1565c0}
button.rescan{min-height:44px;border:1px solid #c9cdc5;background:#f3f4f1;color:#1d2125;border-radius:8px;font-size:15px}
button:disabled{opacity:.5}
#message{font-size:14px;line-height:1.7;white-space:pre-line}
.ok{color:#1b6b2a;font-weight:bold}.ng{color:#b71c1c;font-weight:bold}.busy{font-weight:bold}
[hidden]{display:none!important}
</style></head><body>
<h1>%TITLE%</h1>
<div class="sub">%AP_NAME% ・ %AP_ADDRESS%</div>
<div class="card" id="wifiCard">
  <div class="head"><span>WiFi</span><small id="scanState"></small></div>
  <div id="keepChoices" hidden>
    <label class="choice on" id="keepLabel"><input type="radio" name="wifi" value="keep" id="wifiKeep" checked>
      <span>保存済みの WiFi をそのまま使う<small id="savedSsid"></small></span></label>
    <label class="choice" id="changeLabel"><input type="radio" name="wifi" value="change" id="wifiChange"><span>WiFi を変更する</span></label>
  </div>
  <div class="indent" id="wifiForm">
    <div id="networks"></div>
    <button class="rescan" id="rescan" type="button">探し直す</button>
    <label for="ssid">SSID（一覧にないときは直接入力）</label>
    <input type="text" id="ssid" autocomplete="off" autocapitalize="off">
    <label for="password">パスワード</label>
    <input type="password" id="password" autocomplete="off">
    <label class="show"><input type="checkbox" id="show"> パスワードを表示</label>
    <div class="help" id="wifiHelp">保存するときに、実際に接続できるか確かめます</div>
  </div>
</div>
<div id="fields"></div>
<button class="main" id="connect" type="button">接続して保存</button>
<div class="card"><div id="message">SSID を選んでパスワードを入力してください</div></div>
<script>
const $ = (id) => document.getElementById(id);
const LOCK_ICON = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="#5b636b" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" aria-label="パスワードあり"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';
let networks = [];
let fields = [];  // 各項目に input（入力欄）と wrap（囲み）を足して持つ
let savedSsid = "";

function signal(rssi) {
  if (rssi > -60) return "強";
  if (rssi > -75) return "中";
  return "弱";
}

function showNetworks() {
  const box = $("networks");
  box.innerHTML = "";
  if (networks.length === 0) { box.textContent = "見つかりません"; return; }
  for (const net of networks) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = "net" + (net.ssid === $("ssid").value ? " selected" : "");
    const name = document.createElement("span");
    name.className = "name";
    if (net.locked) name.innerHTML = LOCK_ICON;
    name.append(net.ssid);  // SSID は文字として入れる（HTML として解釈させない）
    const level = document.createElement("span");
    level.className = "level";
    level.textContent = signal(net.rssi);
    row.append(name, level);
    row.onclick = () => { $("ssid").value = net.ssid; showNetworks(); $("password").focus(); };
    box.append(row);
  }
}

// 本機との通信が切れたときに待ち続けないよう、4 秒で諦める
async function getJson(url, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 4000);
  try {
    const response = await fetch(url, { ...(options || {}), signal: controller.signal });
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

async function loadNetworks() {
  try {
    const data = await getJson("/scan");
    $("scanState").textContent = data.scanning ? "検索中…" : "";
    networks = data.networks;
    showNetworks();
    if (data.scanning) setTimeout(loadNetworks, 1000);
  } catch (error) {
    setTimeout(loadNetworks, 2000);  // 一時的に届かなかっただけなら、やり直せば表示される
  }
}

function setMessage(text, kind) {
  $("message").textContent = text;
  $("message").className = kind || "";
}

// ---- アプリ独自の項目 ----

// 前後の空白は取る（貼り付けで紛れ込むため。選択肢の値はそのまま）
function valueOf(f) { return f.type === "select" ? f.input.value : f.input.value.trim(); }

function fieldValues() {
  const values = {};
  for (const f of fields) values[f.key] = valueOf(f);
  return values;
}

// "g19_mode=din|ain" のような規則が成り立つときだけ、項目を出す
function isShown(f, values) {
  if (!f.showWhen) return true;
  const at = f.showWhen.indexOf("=");
  if (at < 0) return true;
  const accepted = f.showWhen.slice(at + 1).split("|");
  return accepted.includes(values[f.showWhen.slice(0, at)]);
}

function updateVisibility() {
  const values = fieldValues();
  for (const f of fields) f.wrap.hidden = !isShown(f, values);
}

function buildField(f) {
  const wrap = document.createElement("div");
  wrap.className = "field";
  const id = "f_" + f.key;
  const label = document.createElement("label");
  label.htmlFor = id;
  label.textContent = f.label;
  let input;
  if (f.type === "select") {
    input = document.createElement("select");
    for (const [value, text] of f.options) {
      const option = document.createElement("option");
      option.value = value;
      option.textContent = text;
      input.append(option);
    }
    // 保存した値が今の選択肢にないとき（アプリを更新して選択肢が変わったなど）は、先頭を選ぶ
    input.value = f.options.some((option) => option[0] === f.value) ? f.value : (f.options[0] ? f.options[0][0] : "");
  } else {
    input = document.createElement("input");
    input.type = f.type === "password" ? "password" : "text";
    input.autocomplete = f.type === "password" ? "new-password" : "off";  // ブラウザが保存済みのログイン情報を入れないように
    input.autocapitalize = "off";
    input.maxLength = f.maxLength;
    if (f.numeric) {
      input.inputMode = "numeric";  // スマホで、数字のキーボードを出す
      if (!f.placeholder) input.placeholder = f.min + "〜" + f.max;
    }
    if (f.mono) input.className = "mono";
    // パスワードの値は本機から送られない。空のまま保存すると、今の値が残る
    if (f.type === "password") input.placeholder = f.set ? "（設定済み。変えるときだけ入力）" : f.placeholder;
    else { input.value = f.value; input.placeholder = f.placeholder; }
  }
  input.id = id;
  input.addEventListener("input", updateVisibility);
  input.addEventListener("change", updateVisibility);
  wrap.append(label, input);
  if (f.help) {
    const help = document.createElement("div");
    help.className = "help";
    help.textContent = f.help;
    wrap.append(help);
  }
  // 必須でないパスワード型で、保存した値があるときだけ、消すためのチェックを出す
  if (f.type === "password" && f.clearable && f.set) {
    const clearLabel = document.createElement("label");
    clearLabel.className = "show";
    const clearBox = document.createElement("input");
    clearBox.type = "checkbox";
    clearBox.id = "c_" + f.key;
    clearLabel.append(clearBox, " 保存してある値を消す");
    wrap.append(clearLabel);
    f.clearBox = clearBox;
  }
  f.input = input;
  f.wrap = wrap;
  return wrap;
}

// 見出し（group）が変わるたびに、新しいカードにする
function renderFields() {
  const box = $("fields");
  box.innerHTML = "";
  let card = null;
  let lastGroup = null;
  for (const f of fields) {
    if (card === null || f.group !== lastGroup) {
      card = document.createElement("div");
      card.className = "card";
      if (f.group) {
        const head = document.createElement("div");
        head.className = "head";
        head.textContent = f.group;
        card.append(head);
      }
      box.append(card);
      lastGroup = f.group;
    }
    card.append(buildField(f));
  }
  updateVisibility();
}

async function loadFields() {
  const data = await getJson("/fields");
  savedSsid = data.savedSsid;
  fields = data.fields;
  renderFields();
  if (savedSsid) {
    $("keepChoices").hidden = false;
    $("savedSsid").textContent = savedSsid + "（保存済み）";
  }
  updateWifiMode();
}

// ---- WiFi ----

function keepsWifi() { return savedSsid !== "" && $("wifiKeep").checked; }

function updateWifiMode() {
  const keep = keepsWifi();
  $("wifiForm").hidden = keep;
  $("keepLabel").className = "choice" + (keep ? " on" : "");
  $("changeLabel").className = "choice" + (!keep ? " on" : "");
  $("connect").textContent = keep ? "保存して再起動" : "接続して保存";
  setMessage(keep ? "内容を確かめて「保存して再起動」を押してください" : "SSID を選んでパスワードを入力してください");
  if (!keep) loadNetworks();
}

const LOST_MESSAGE = "本機との通信が切れました。ランプが青になっていれば接続できています。赤の点滅なら、もう一度この画面を開いてください。";
const FAIL_MESSAGES = {
  password: "パスワードが違うようです。確かめて、もう一度試してください。",
  notfound: "SSID が見つかりません。電波が届くか、名前が正しいか確かめてください。",
};
let statusErrors = 0;

// 接続先のチャンネルに合わせて本機の電波が切り替わり、スマホとの通信が切れることがある。3 回続けて届かなければ、そう伝える
async function waitResult() {
  let data;
  try {
    data = await getJson("/status");
    statusErrors = 0;
  } catch (error) {
    statusErrors++;
    if (statusErrors >= 3) { setMessage(LOST_MESSAGE, "ng"); return; }
    setTimeout(waitResult, 1000);
    return;
  }
  if (data.state === "trying") { setTimeout(waitResult, 1000); return; }
  if (data.state === "connected") { showSaved(data); return; }  // 再起動するので、ボタンは押せないままにする
  $("connect").disabled = false;
  setMessage(FAIL_MESSAGES[data.reason] || "接続できませんでした。SSID とパスワードを確かめて、もう一度試してください。", "ng");
}

function showSaved(data) {
  const text = data.kept
    ? "保存しました。\n再起動します。ランプが青になれば完了です。"
    : "接続しました（" + data.ssid + "）\nIP: " + data.ip + "\n設定を保存して再起動します。ランプが青になれば完了です。";
  setMessage(text, "ok");
}

// 本機と同じ決まりで確かめる。SSID はバイト数で数える。前後の空白も SSID の一部なので削らない
function checkWifi(ssid, password) {
  if (ssid.trim() === "") return "SSID を選ぶか入力してください";
  if (new TextEncoder().encode(ssid).length > 32) return "SSID は 32 バイト（日本語はおよそ 10 文字）までです";
  if (password && (password.length < 8 || password.length > 63 || !/^[\x20-\x7e]*$/.test(password))) {
    return "パスワードは半角の英数字・記号で 8〜63 文字です";
  }
  return "";
}

// 整数として読めて、min〜max に収まるか（本機と同じ決まり。符号は、min が負のときだけ）
function isIntegerInRange(text, min, max) {
  const pattern = min < 0 ? /^-?[0-9]{1,9}$/ : /^[0-9]{1,9}$/;
  if (!pattern.test(text)) return false;
  const value = Number(text);
  return value >= min && value <= max;
}

function checkFields() {
  const values = fieldValues();
  for (const f of fields) {
    if (!isShown(f, values)) continue;
    const value = valueOf(f);
    const empty = value === "" && !(f.type === "password" && f.set);
    if (f.required && empty) return f.label + " を入力してください";
    if (value !== "" && f.numeric && !isIntegerInRange(value, f.min, f.max)) return f.label + " は、" + f.min + "〜" + f.max + " の整数で入力してください";
    if (value !== "" && f.identifier && !/^[A-Za-z0-9._-]+$/.test(value)) return f.label + " は、半角の英数字と . _ - だけ使えます";
    if (value !== "" && f.startsWith && !value.startsWith(f.startsWith)) return f.label + " は " + f.startsWith + " で始めてください";
    if (new TextEncoder().encode(value).length > f.maxLength) return f.label + " が長すぎます";
  }
  return "";
}

async function save() {
  const keep = keepsWifi();
  const ssid = $("ssid").value;
  const password = $("password").value;
  const problem = (keep ? "" : checkWifi(ssid, password)) || checkFields();
  if (problem) { setMessage(problem, "ng"); return; }
  const body = new URLSearchParams();
  if (!keep) { body.set("ssid", ssid); body.set("password", password); }
  for (const f of fields) {
    body.set("f_" + f.key, valueOf(f));
    if (f.clearBox && f.clearBox.checked) body.set("c_" + f.key, "1");
  }
  $("connect").disabled = true;
  setMessage(keep ? "保存しています…" : "接続しています…（最大15秒）", "busy");
  const data = await getJson(keep ? "/keep" : "/connect", { method: "POST", body: body });
  if (!data.ok) { $("connect").disabled = false; setMessage(data.error, "ng"); return; }
  statusErrors = 0;
  setTimeout(waitResult, keep ? 300 : 1000);
}

$("ssid").oninput = showNetworks;
$("show").onchange = () => { $("password").type = $("show").checked ? "text" : "password"; };
$("rescan").onclick = async () => { await getJson("/rescan", { method: "POST" }).catch(() => {}); loadNetworks(); };
$("wifiKeep").onchange = updateWifiMode;
$("wifiChange").onchange = updateWifiMode;
$("connect").onclick = () => save().catch(() => {
  setMessage(LOST_MESSAGE, "ng");
  if (keepsWifi()) $("connect").disabled = false;  // 保存済みの WiFi を使うときは、WiFi が切れないので、押し直せる
});
loadFields().catch(() => setTimeout(() => location.reload(), 2000));
</script></body></html>)HTML";
