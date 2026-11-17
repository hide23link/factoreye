// 画面の明るさ（設定 › 表示）を、画面を描く前に <html data-theme> に付ける（明るい設定で開いたとき、一瞬暗く光らないように）。
// index.html が、画面の本体より先に読み込む。読み方は src/lib/theme.ts と同じ
// （保存の名前 factoreye.theme、値 dark / light / system）。保存が読めなければ暗い。
// インラインの <script> にしないのは、セキュリティの設定（インラインのスクリプトを止める設定）でも動くようにするため。
(function () {
  var mode = "dark";
  try {
    mode = localStorage.getItem("factoreye.theme") || "dark";
  } catch (e) {
    // 保存が使えない（プライベートモードなど）ときは暗いのまま
  }
  var prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  var light = mode === "light" || (mode === "system" && prefersLight);
  document.documentElement.setAttribute("data-theme", light ? "light" : "dark");
})();
