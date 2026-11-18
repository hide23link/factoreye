/**
 * セットアップガイドの、縦に並ぶ 1 段階分の行（左に番号の札と縦線、右に内容）。
 * 済んだ段階は ✓（緑）、今の段階は塗りつぶし（水色）、これからの段階は枠だけ（灰）。
 *
 * 【誰が使うか】SetupWizard。
 * 【引数（props）】number = 段階の番号、state = done / current / todo、last = 最後の行（下に縦線を引かない）、
 *   children = 右の内容（見出しや、今の段階の操作）。
 */
import type { ReactNode } from "react";

export type StepRowState = "done" | "current" | "todo";

const BUBBLE_STYLE: Record<StepRowState, { borderColor: string; color: string; background?: string }> = {
  done: { borderColor: "var(--fe-ok)", color: "var(--fe-ok)" },
  current: { borderColor: "var(--fe-cy)", color: "var(--fe-bg)", background: "var(--fe-cy)" },
  todo: { borderColor: "var(--fe-line)", color: "var(--fe-mut)" },
};

export function StepRow({ number, state, last = false, children }: { number: number; state: StepRowState; last?: boolean; children: ReactNode }) {
  return (
    <li className="flex gap-3.5" aria-current={state === "current" ? "step" : undefined}>
      <div className="flex w-7 flex-none flex-col items-center gap-1.5">
        <span
          className="flex h-[26px] w-[26px] flex-none items-center justify-center rounded-[3px] border-[1.5px] font-num text-xs font-bold"
          style={BUBBLE_STYLE[state]}
          role="img"
          aria-label={state === "done" ? `${number} 済み` : `${number}`}
        >
          {state === "done" ? "✓" : number}
        </span>
        {!last && <span className="min-h-[14px] w-px flex-1" style={{ background: "var(--fe-line)" }} aria-hidden="true" />}
      </div>
      <div className={`min-w-0 flex-1 ${last ? "pb-0" : "pb-5"} pt-0.5`}>{children}</div>
    </li>
  );
}
