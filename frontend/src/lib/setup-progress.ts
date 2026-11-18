/**
 * セットアップガイドの進み具合（段階・登録したセンサー・作ったダッシュボード）を、この端末に覚えておく。
 * 途中でやめても、次に開いたときに続きから再開できるようにするため。画面に依存しない関数だけを置く。
 *
 * 【誰が使うか】SetupWizard（セットアップガイド）。
 */

/** 段階の番号（1 センサー登録・2 テストデータ送信・3 計器盤を作る・4 完了） */
export type SetupStep = 1 | 2 | 3 | 4;

/** 覚えておく内容。センサーを登録する前（段階 1）は、センサーは無い */
export interface SetupProgress {
  step: SetupStep;
  sensor: { id: string; name: string; ingestKey: string; unit: string } | null;
  dashboardId: string | null;
}

const STORAGE_KEY = "factoreye.setup-guide";

/** まだ何も始めていないときの状態 */
export const INITIAL_PROGRESS: SetupProgress = { step: 1, sensor: null, dashboardId: null };

/**
 * 覚えておいた進み具合を読む。何も無い・壊れている・ブラウザが保存を許していないときは、最初の状態を返す。
 * 段階 2 以降なのにセンサーが無いような、つじつまの合わない内容も、最初の状態に戻す。
 * 例: 段階 2 とセンサー {id:"s1",…} が入っていれば、そのまま返す
 */
export function loadSetupProgress(): SetupProgress {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return INITIAL_PROGRESS;
    const parsed = JSON.parse(raw) as Partial<SetupProgress>;
    const step = parsed.step;
    if (step !== 1 && step !== 2 && step !== 3 && step !== 4) return INITIAL_PROGRESS;
    const sensor = parsed.sensor ?? null;
    const sensorOk =
      sensor !== null &&
      typeof sensor.id === "string" &&
      typeof sensor.name === "string" &&
      typeof sensor.ingestKey === "string" &&
      typeof sensor.unit === "string";
    if (step >= 2 && !sensorOk) return INITIAL_PROGRESS;
    const dashboardId = typeof parsed.dashboardId === "string" ? parsed.dashboardId : null;
    if (step === 4 && dashboardId === null) return INITIAL_PROGRESS;
    return { step, sensor: sensorOk ? sensor : null, dashboardId };
  } catch {
    return INITIAL_PROGRESS;
  }
}

/** 進み具合を覚える。保存できない環境（プライベートウィンドウなど）では、何もしない（ガイドは動く） */
export function saveSetupProgress(progress: SetupProgress): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(progress));
  } catch {
    // 覚えられないだけで、ガイドそのものは続けられる
  }
}

/** 覚えた進み具合を消す（やり直すとき・最後まで終わったとき） */
export function clearSetupProgress(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // 消せなくても困らない
  }
}

/**
 * 済んだ段階の数（0〜4）。「1 / 4 完了」の左の数字。
 * 例: 段階 2 の画面 → 1、完了の画面（段階 4）→ 4
 */
export function completedCount(step: SetupStep): number {
  return step === 4 ? 4 : step - 1;
}

/**
 * 進み具合の 4 本の帯の状態。済んだ段階は done、今の段階は current、これからは todo。
 * 例: 段階 2 → ["done", "current", "todo", "todo"]、完了の画面 → すべて done
 */
export function stepBarStates(step: SetupStep): Array<"done" | "current" | "todo"> {
  return ([1, 2, 3, 4] as const).map((n) => (step === 4 || n < step ? "done" : n === step ? "current" : "todo"));
}

/**
 * 待ち時間の文字（分:秒）。
 * 例: 42000 → "00:42"、125000 → "02:05"
 */
export function formatWaitTime(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}
