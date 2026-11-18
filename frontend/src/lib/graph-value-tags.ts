/**
 * グラフの右の「今の値の札」を、どの高さに置くかを決める。
 *
 * 札は、その線の最後の点の高さ（y）に、札の真ん中が来るように置く。
 * 値が近い線の札は重なるので、上から順に、重ならない分だけ下へずらす。
 * 下にはみ出したら、下から順に上へ戻す。矢印は、ずらしても元の高さ（y）を指す。
 *
 * 例: 高さ 200、札の高さ 32、y = [50, 55, undefined]
 *   → 1 つ目は上端 40（50 - 10）、2 つ目は 1 つ目のすぐ下の 74、高さの分からない 3 つ目はその下の 108
 */

/** 札の上端から、数字の枠の真ん中までの距離（数字の枠の高さ 20px の半分） */
export const TAG_CENTER_OFFSET = 10;
/** 札 1 つの高さ（数字の枠 20px ＋ 下の名前・単位 12px） */
export const TAG_BLOCK_HEIGHT = 32;
/** 札と札のすきま */
export const TAG_GAP = 2;

/**
 * 札の上端の位置（px）を、渡した順に返す。
 * @param ys 線ごとの、最後の点の高さ（グラフの上端からの px）。分からない線は undefined（ほかの札の下に並べる）
 * @param height 札を並べる欄の高さ（px）
 * @returns 例: layoutValueTags([50, 55, undefined], 200) → [40, 74, 108]
 */
export function layoutValueTags(ys: ReadonlyArray<number | undefined>, height: number): number[] {
  const step = TAG_BLOCK_HEIGHT + TAG_GAP;
  // 高さの分かる札を上から順に、その後ろに高さの分からない札を、渡した順に並べる
  const order = ys
    .map((y, index) => ({ index, wanted: y === undefined ? Number.POSITIVE_INFINITY : y - TAG_CENTER_OFFSET }))
    .sort((a, b) => a.wanted - b.wanted || a.index - b.index);

  // 上から: 望む位置か、1 つ上の札のすぐ下の、低い方（下にある方）に置く
  const tops: number[] = [];
  order.forEach((tag, i) => {
    const below = i === 0 ? 0 : tops[i - 1] + step;
    const wanted = Number.isFinite(tag.wanted) ? tag.wanted : below;
    tops.push(Math.max(0, wanted, below));
  });
  // 下から: 欄の下にはみ出す札と、1 つ下の札にかかる札を、上へ戻す（上端 0 より上には出さない）
  for (let i = tops.length - 1; i >= 0; i--) {
    const limit = i === tops.length - 1 ? height - TAG_BLOCK_HEIGHT : tops[i + 1] - step;
    tops[i] = Math.max(0, Math.min(tops[i], limit));
  }

  const result: number[] = new Array(ys.length);
  order.forEach((tag, i) => {
    result[tag.index] = tops[i];
  });
  return result;
}
