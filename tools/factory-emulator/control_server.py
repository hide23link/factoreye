"""エミュレータ手動操作用の簡易Web画面（標準ライブラリのみ、追加依存なし）。

emulator.py のMachineStateをスライダーで直接操作できるようにする。しきい値アラームを
狙って発生させたい時など、自動のランダムウォークでは狙った値に調整しづらい場合に使う。
各指標（生産負荷・温度・電力）は「自動」(従来のランダムウォーク) と「手動」(スライダーの
目標値へじわじわ収束＋小さなノイズ) をそれぞれ独立に切り替えられる。

emulator.pyのMachineStateと同じプロセス内で、別スレッドのHTTPサーバーとして動く
（docker-composeのbackend/frontendとはポートが別、既定で8765番）。
"""
from __future__ import annotations

import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from emulator import MachineState

CONTROL_PORT = 8765

_PAGE = """<!doctype html>
<html lang="ja">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>エミュレータ手動操作</title>
<style>
  body { font-family: -apple-system, "Hiragino Sans", sans-serif; max-width: 520px;
         margin: 24px auto; padding: 0 16px; color: #1f2937; }
  h1 { font-size: 18px; margin-bottom: 4px; }
  p.hint { color: #6b7280; font-size: 13px; margin-top: 0; }
  .card { border: 1px solid #e5e7eb; border-radius: 8px; padding: 14px 16px; margin-bottom: 14px; }
  .card h2 { font-size: 14px; margin: 0 0 8px; display: flex; justify-content: space-between; align-items: center; }
  .value { font-variant-numeric: tabular-nums; font-weight: 700; font-size: 18px; }
  label.toggle { display: flex; align-items: center; gap: 6px; font-size: 13px; font-weight: normal; color: #374151; }
  input[type=range] { width: 100%; margin: 6px 0; }
  .row { display: flex; justify-content: space-between; font-size: 11px; color: #9ca3af; }
  .paused { color: #b45309; font-size: 12px; }
</style>
</head>
<body>
<h1>テスト工場エミュレータ 手動操作</h1>
<p class="hint">「手動」をONにしたスライダーの値へ少しずつ近づき、小さなランダム変動が乗ります。しきい値を跨ぐ値に動かせば、その場でアラームを発生/解除させられます。</p>

<div class="card">
  <h2>生産負荷 <span class="value" id="v-production">—</span>%
    <label class="toggle"><input type="checkbox" id="m-production"> 手動</label>
  </h2>
  <input type="range" id="s-production" min="0" max="100" step="1">
  <div class="row"><span>0</span><span>100</span></div>
  <p class="hint">生産数(個/5秒)・温度・電力は、手動時でないこの負荷から自動計算されます。</p>
</div>

<div class="card">
  <h2>温度 <span class="value" id="v-temperature">—</span>°C
    <label class="toggle"><input type="checkbox" id="m-temperature"> 手動</label>
  </h2>
  <input type="range" id="s-temperature" min="0" max="100" step="0.5">
  <div class="row"><span>0</span><span>100</span></div>
</div>

<div class="card">
  <h2>電力 <span class="value" id="v-power">—</span>kW
    <label class="toggle"><input type="checkbox" id="m-power"> 手動</label>
  </h2>
  <input type="range" id="s-power" min="0" max="20" step="0.1">
  <div class="row"><span>0</span><span>20</span></div>
</div>

<p class="paused" id="paused-note" style="display:none">⏸ 現在エミュレータは自動の一時停止中です</p>

<script>
const metrics = ["production", "temperature", "power"];
let dragging = null; // ドラッグ中のスライダーIDはpollingで上書きしない

for (const m of metrics) {
  const slider = document.getElementById("s-" + m);
  const toggle = document.getElementById("m-" + m);
  slider.addEventListener("input", () => { dragging = m; sendControl(m); });
  slider.addEventListener("change", () => { dragging = null; });
  toggle.addEventListener("change", () => sendControl(m));
}

function sendControl(metric) {
  const slider = document.getElementById("s-" + metric);
  const toggle = document.getElementById("m-" + metric);
  fetch("/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ [metric]: { manual: toggle.checked, target: Number(slider.value) } }),
  });
}

async function poll() {
  try {
    const res = await fetch("/state");
    const data = await res.json();
    for (const m of metrics) {
      document.getElementById("v-" + m).textContent = data[m].value;
      document.getElementById("m-" + m).checked = data[m].manual;
      if (dragging !== m) {
        document.getElementById("s-" + m).value = data[m].manual ? data[m].target : data[m].value;
      }
    }
    document.getElementById("paused-note").style.display = data.paused ? "block" : "none";
  } catch (e) { /* バックエンド未起動時などは静かに無視し、次回pollで再試行 */ }
}
setInterval(poll, 1000);
poll();
</script>
</body>
</html>
"""


def _make_handler(
    state: "MachineState", lock: threading.Lock
) -> type[BaseHTTPRequestHandler]:
    class Handler(BaseHTTPRequestHandler):
        def log_message(self, format: str, *args: Any) -> None:  # noqa: A002
            pass  # /stateを1秒ごとにpollするため、標準の毎リクエストアクセスログは出さない

        def do_GET(self) -> None:
            if self.path == "/":
                self._send_html(_PAGE)
            elif self.path == "/state":
                with lock:
                    body = json.dumps(state.to_control_dict()).encode("utf-8")
                self._send_json(body)
            else:
                self.send_error(404)

        def do_POST(self) -> None:
            if self.path != "/control":
                self.send_error(404)
                return
            length = int(self.headers.get("Content-Length", 0))
            raw = self.rfile.read(length)
            try:
                payload = json.loads(raw)
            except json.JSONDecodeError:
                self.send_error(400, "invalid JSON body")
                return
            with lock:
                state.apply_control(payload)
            self._send_json(b'{"ok":true}')

        def _send_html(self, html: str) -> None:
            body = html.encode("utf-8")
            self.send_response(200)
            self.send_header("Content-Type", "text/html; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def _send_json(self, body: bytes) -> None:
            self.send_response(200)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

    return Handler


def start(state: "MachineState", lock: threading.Lock) -> None:
    """バックグラウンドスレッドで操作画面を起動する（呼び出し元をブロックしない）。"""
    handler = _make_handler(state, lock)
    httpd = ThreadingHTTPServer(("0.0.0.0", CONTROL_PORT), handler)
    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f"手動操作画面: http://localhost:{CONTROL_PORT}")
