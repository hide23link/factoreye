/**
 * 「表示」設定パネル（設定画面）。画面の明るさを、暗い（初期値）・明るい・端末に合わせる、から選ぶ。
 * 選ぶとすぐ切り替わり、この端末のブラウザにだけ保存する（ほかの人の画面は変わらない）。
 *
 * 【誰が使うか】SettingsPage.tsx が、「表示」のタブで出す。引数（props）はない。
 */
import type { ThemeMode } from "../../lib/theme";
import { useThemeStore } from "../../store/useThemeStore";

/** 選択肢の小さな見本の色（モードの見た目そのものを見せるため、変数ではなく決まった色にする） */
interface Swatch {
  ground: string;
  panel: string;
  line: string;
  ink: string;
  threshold: string;
}

const DARK: Swatch = { ground: "#090c0f", panel: "#10151a", line: "#232b34", ink: "#e6edf3", threshold: "#3fd3f5" };
const LIGHT: Swatch = { ground: "#eef1f4", panel: "#ffffff", line: "#cbd2d9", ink: "#0d1217", threshold: "#00778c" };

const OPTIONS: { mode: ThemeMode; title: string; description: string; swatch: Swatch }[] = [
  { mode: "dark", title: "暗い", description: "監視室・夜間・壁掛けのモニター向け（初期値）", swatch: DARK },
  { mode: "light", title: "明るい", description: "日中の事務所・明るい現場向け", swatch: LIGHT },
  { mode: "system", title: "端末の設定に合わせる", description: "パソコン・スマホのダーク／ライトの設定に従う", swatch: LIGHT },
];

/** 選択肢の見本（地・板・折れ線・しきい値の線）。飾りなので読み上げない */
function ThemeSample({ swatch }: { swatch: Swatch }) {
  return (
    <svg viewBox="0 0 120 56" className="h-16 w-full rounded" aria-hidden="true" style={{ background: swatch.ground }}>
      <rect x="6" y="6" width="108" height="44" rx="2" fill={swatch.panel} stroke={swatch.line} />
      <line x1="10" y1="20" x2="110" y2="20" stroke={swatch.threshold} strokeDasharray="3 2" />
      <polyline points="10,40 26,38 42,33 58,35 74,26 90,22 110,17" fill="none" stroke={swatch.ink} strokeWidth="1.5" />
    </svg>
  );
}

/** 設定パネル。 */
export function DisplaySettingsPanel() {
  const mode = useThemeStore((s) => s.mode);
  const setMode = useThemeStore((s) => s.setMode);

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-bold text-gray-900">画面の明るさ</h2>
        <p className="text-sm text-gray-500">
          選ぶとすぐ切り替わります。この端末だけに保存します（ほかの人の画面は変わりません）。
          色の意味（しきい値・注意・警報）は、どちらでも同じです。
        </p>
      </div>
      <div role="radiogroup" aria-label="画面の明るさ" className="grid gap-3 sm:grid-cols-3">
        {OPTIONS.map((option) => {
          const checked = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              onClick={() => setMode(option.mode)}
              className={`flex flex-col gap-2 rounded border-2 p-3 text-left ${
                checked ? "border-blue-600 bg-blue-50" : "border-gray-200 bg-white hover:border-gray-400"
              }`}
            >
              <ThemeSample swatch={option.swatch} />
              <span className="text-sm font-bold text-gray-900">{option.title}</span>
              <span className="text-xs text-gray-500">{option.description}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
