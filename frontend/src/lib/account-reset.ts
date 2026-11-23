/**
 * アカウントが替わるとき（ログアウト・強制ログアウト・別のアカウントでのログイン・管理者の閲覧の開始と終了）に、
 * 前のアカウントのデータが次のアカウントに見えないよう、アカウントに結び付く状態を空にする。
 *
 * 消すもの（アカウント固有）:
 * - React Query のキャッシュ（センサー・ダッシュボード・アラームなどの取得結果）
 * - 画面の状態のうち、選んでいるダッシュボード・開いている画面・編集中の状態（元に戻す履歴はウィジェットの中身を持つ）
 * - グラフのカーソル（時刻と、その時刻のセンサーの名前・値）
 * - localStorage の「最後に見たダッシュボード」と「セットアップガイドの進み具合」（センサーの Ingest Key を含む）
 * 消さないもの（この端末の設定。誰が使っても同じ）:
 * - 画面の明るさ（テーマ）、キオスクの設定、グラフの見え方、表示時間の範囲、更新間隔、
 *   窓の位置と大きさ、センサー棚の言葉、見取り図の種類
 * - 「新しいセンサー」の記録は、もともとワークスペースごとに鍵を分けてあるので、そのまま
 *
 * 【誰が使うか】store/useAuthStore.ts（clearAuth・setAuth・setImpersonated）。
 * 循環 import を避けるため、このファイルは useAuthStore を読み込まない。
 */
import { queryClient } from "../queryClient";
import { useCursorTimeStore } from "../store/useCursorTimeStore";
import { useEditorStore } from "../store/useEditorStore";
import { useTrendCursorStore } from "../store/useTrendCursorStore";
import { useUiStore } from "../store/useUiStore";
import { writeLastDashboardId } from "./last-dashboard";
import { clearSetupProgress } from "./setup-progress";

/** アカウントに結び付く状態を、すべて空にする。 */
export function resetAccountScopedState(): void {
  queryClient.clear();
  // 画面の状態: 選んでいるダッシュボードなどを戻す（グラフのリンクの情報は、URL から来るので触らない）
  useUiStore.setState({
    view: "main",
    selectedDashboardId: null,
    openInEditMode: false,
    kiosk: false,
    linkNotFound: false,
  });
  useEditorStore.getState().reset();
  useCursorTimeStore.getState().reset();
  useTrendCursorStore.getState().clearAll();
  writeLastDashboardId(null);
  clearSetupProgress();
}
