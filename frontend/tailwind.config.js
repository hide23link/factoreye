/**
 * Tailwind の設定。
 *
 * 色（gray・blue・red など）は、決まった色ではなく CSS 変数を指す。変数の値は src/theme.css が
 * 「暗い（操作室の色）」「明るい（従来の色）」の 2 組を持ち、<html data-theme="…"> で切り替える。
 * こうすると、各画面の bg-gray-50・text-blue-600 などを書き換えずに、全画面の色が切り替わる。
 * `<alpha-value>` は、bg-white/80 のような透明度の指定を効かせるため（変数は「R G B」の数字で持つ）。
 * black は重ねる暗幕（bg-black/40）にだけ使うので、どちらのモードでも黒のまま（置き換えない）。
 */
const SHADES = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900, 950];

/** 色の名前（gray など）の、濃さごとの CSS 変数（例: gray-500 → rgb(var(--gray-500) / <alpha-value>)） */
function scale(name) {
  return Object.fromEntries(SHADES.map((shade) => [shade, `rgb(var(--${name}-${shade}) / <alpha-value>)`]));
}

/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,ts,jsx,tsx}"],
  theme: {
    extend: {
      colors: {
        white: "rgb(var(--white) / <alpha-value>)",
        gray: scale("gray"),
        slate: scale("gray"),
        blue: scale("blue"),
        red: scale("red"),
        green: scale("green"),
        amber: scale("amber"),
        yellow: scale("amber"),
      },
      fontFamily: {
        // 数字（測定値・時刻・目盛り）は、操作室の表示用に作られた B612 Mono（0 と O、1 と l が見分けやすく、桁がそろう）
        num: ['"B612 Mono"', "ui-monospace", "SFMono-Regular", "Menlo", "monospace"],
      },
    },
  },
  plugins: [],
};
