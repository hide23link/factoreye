/**
 * 「表示」設定パネル（設定画面）。画面の明るさを、暗い（初期値）・明るい・端末に合わせる、から選ぶ。
 * 選ぶとすぐ切り替わる。保存先は 2 つから選べる:
 * - この端末だけ（既定）: この端末のブラウザにだけ保存する。ほかの人の画面は変わらない
 * - 全員の初期値にする: サーバーに保存する（PUT /api/settings/display）。この端末で選んでいない端末は、この値で始まる。
 *   選んだこの端末も、自分の選択を消して、この値に従う
 * 画面表示モード（壁掛けモニター）は、この設定とは別に「常に暗い」とする（キオスクの画面側の決まり）。
 *
 * 【誰が使うか】SettingsPage.tsx が、「表示」のタブで出す。引数（props）はない。
 */
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

import { updateDisplaySettings } from "../../lib/api";
import type { ThemeMode } from "../../lib/theme";
import { useThemeStore } from "../../store/useThemeStore";
import { useUiStore } from "../../store/useUiStore";

/** 保存先の選択肢。device=この端末だけ、everyone=全員の初期値 */
type SaveScope = "device" | "everyone";

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

/** 「今の表示」の文字。例: 暗い、端末に合わせる（今は明るい） */
function describeMode(mode: ThemeMode, applied: "dark" | "light"): string {
  if (mode === "dark") return "暗い";
  if (mode === "light") return "明るい";
  return `端末に合わせる（今は${applied === "light" ? "明るい" : "暗い"}）`;
}

/** 設定パネル。 */
export function DisplaySettingsPanel() {
  const queryClient = useQueryClient();
  const mode = useThemeStore((s) => s.mode);
  const applied = useThemeStore((s) => s.applied);
  const saved = useThemeStore((s) => s.saved);
  const setMode = useThemeStore((s) => s.setMode);
  const followServerDefault = useThemeStore((s) => s.followServerDefault);
  const setView = useUiStore((s) => s.setView);
  const [scope, setScope] = useState<SaveScope>("device");
  const [error, setError] = useState<string | null>(null);

  // 全員の初期値として保存する。保存できたら、この端末の選択を消して、その値に従う
  const saveDefault = useMutation({
    mutationFn: (next: ThemeMode) => updateDisplaySettings({ defaultTheme: next }),
    onSuccess: (_data, next) => {
      void queryClient.invalidateQueries({ queryKey: ["display-settings"] });
      followServerDefault(next);
      setError(null);
    },
    onError: () => setError("全員の初期値を保存できませんでした。もう一度お試しください。"),
  });

  /** 明るさを選んだとき。保存先に合わせて、この端末か全員の初期値に保存する */
  const choose = (next: ThemeMode) => {
    if (scope === "everyone") saveDefault.mutate(next);
    else {
      setError(null);
      setMode(next);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <h2 className="mb-1 text-lg font-bold text-gray-900">画面の明るさ</h2>
        <p className="text-sm text-gray-500">
          選ぶとすぐ切り替わります。色の意味（しきい値・注意・警報）は、どちらでも同じです。
        </p>
      </div>
      <div role="radiogroup" aria-label="画面の明るさ" className="grid gap-3 sm:grid-cols-3">
        {OPTIONS.map((option, index) => {
          const checked = mode === option.mode;
          return (
            <button
              key={option.mode}
              type="button"
              role="radio"
              aria-checked={checked}
              // ラジオボタンの決まり: 選ばれているものだけ Tab で止まり、矢印キーで前後を選ぶ
              tabIndex={checked ? 0 : -1}
              onKeyDown={(event) => {
                const step = event.key === "ArrowRight" || event.key === "ArrowDown" ? 1 : event.key === "ArrowLeft" || event.key === "ArrowUp" ? -1 : 0;
                if (step === 0) return;
                event.preventDefault();
                const next = OPTIONS[(index + step + OPTIONS.length) % OPTIONS.length];
                choose(next.mode);
                const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>("[role=radio]");
                buttons?.[(index + step + OPTIONS.length) % OPTIONS.length]?.focus();
              }}
              onClick={() => choose(option.mode)}
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

      <fieldset className="space-y-2 rounded border border-gray-200 bg-white p-3">
        <legend className="px-1 text-sm font-bold text-gray-900">どこに保存するか</legend>
        <label className="flex items-center gap-2 text-sm text-gray-900">
          <input type="radio" name="theme-scope" checked={scope === "device"} onChange={() => setScope("device")} />
          この端末だけ（ほかの人の画面は変わりません）
        </label>
        <label className="flex items-center gap-2 text-sm text-gray-900">
          <input type="radio" name="theme-scope" checked={scope === "everyone"} onChange={() => setScope("everyone")} />
          全員の初期値にする
          <span className="text-xs text-gray-500">（この端末で明るさを選んでいない人の画面が、この値で始まります）</span>
        </label>
        <p className="text-xs text-gray-500">画面表示モード（壁掛けモニター）は、この設定とは別に「常に暗い」で表示します。</p>
        {error && (
          <p role="alert" className="text-sm text-red-600">
            {error}
          </p>
        )}
      </fieldset>

      <div className="flex flex-wrap items-center gap-3 rounded border border-gray-200 bg-white p-3">
        <span className="flex-1 text-xs text-gray-500">
          今の表示: <b className="font-num text-gray-900">{describeMode(mode, applied)}</b>
          {!saved && <span className="ml-1">（全員の初期値）</span>}
        </span>
        <button type="button" onClick={() => setView("main")} className="h-8 rounded bg-blue-600 px-3 text-xs font-bold text-white hover:bg-blue-700">
          計器盤へ
        </button>
      </div>
    </div>
  );
}
