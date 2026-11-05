/**
 * 日本語入力（IME）の変換を確定する Enter かどうか。
 * 変換確定の Enter で、入力欄の「Enter で保存」が働いてしまうと、途中の文字が保存される。
 * isComposing（変換中）か、keyCode 229（一部のブラウザで、確定の Enter に付く値）なら true。
 *
 * 【誰が使うか】Enter で確定する入力欄（センサー設定の編集行、NumberField、ダッシュボードの名前・説明）。
 */
export function isImeComposing(event: { nativeEvent?: { isComposing?: boolean; keyCode?: number }; isComposing?: boolean; keyCode?: number }): boolean {
  const native = event.nativeEvent ?? event;
  return native.isComposing === true || event.keyCode === 229 || native.keyCode === 229;
}
