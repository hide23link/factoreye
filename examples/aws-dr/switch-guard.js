// 切り替え（DNS の付け替え）の安全装置の抜粋。Cloudflare Worker の DR コンソールの一部を、読みやすく簡略化したもの。
// そのままは動かない参考コード。facts（行き先のトンネル・控えのアプリの /health・各リージョンの EC2 の状態）は、別の処理が集める。
// 付け替えるのは、人がボタンを押したときだけ。自動では切り替えない。

const REGIONS = ["ap-northeast-1", "ap-northeast-3", "ap-south-1"]; // 東京・大阪・ムンバイ
const isUp = (inst) => inst && !inst.error && ["running", "pending"].includes(inst.state);

// 戻り値: null なら付け替えてよい。文字列なら、断る理由
export function refuseReason({ to, region, serving, facts }) {
  if (to !== "aws" && to !== "proxmox") return "to は aws か proxmox";
  if (serving === to) return `すでに ${to} に向いています`;

  // 1. 行き先が生きていること（確認せずに付け替えて、3 分止まったことがある）
  const dest = to === "aws" ? facts.tunnels.aws : facts.tunnels.proxmox;
  if (!dest || dest.connections < 1) return `${to} 側のトンネルが接続されていないため、付け替えません`;
  if (to === "aws" && !facts.standbyHealthOk) return "控えのアプリが /health に応答しないため、付け替えません";

  // 2. 指定したリージョンの控えが動いていて、ほかの控えは動いていないこと（データが 2 つに分かれるのを防ぐ）
  if (to === "aws") {
    if (!REGIONS.includes(region)) return "region が不正です";
    if (!isUp(facts.instances[region])) return `${region} の控えが起動していないため、付け替えません`;
    const others = REGIONS.filter((r) => r !== region && isUp(facts.instances[r]));
    if (others.length) return `${others.join("・")} の控えも起動しています。使わない控えを停止してから切り替えてください`;
  }
  return null;
}
