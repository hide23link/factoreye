#!/bin/bash
# FactorEye Proxmox LXC102 初期セットアップ
# 前提: Ubuntu 24.04 LTS、Step 1（apt/UFW）・Step 2（Cloudflare Tunnel）完了済み
# 使い方: ssh root@100.70.133.58 'bash -s' < infra/cloud/setup-server.sh

set -euo pipefail

echo "=== Docker インストール ==="
apt-get update -q
apt-get install -y ca-certificates curl gnupg

install -m 0755 -d /etc/apt/keyrings
curl -fsSL https://download.docker.com/linux/ubuntu/gpg \
  | gpg --dearmor -o /etc/apt/keyrings/docker.gpg
chmod a+r /etc/apt/keyrings/docker.gpg

echo \
  "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] \
  https://download.docker.com/linux/ubuntu \
  $(. /etc/os-release && echo "$VERSION_CODENAME") stable" \
  | tee /etc/apt/sources.list.d/docker.list > /dev/null

apt-get update -q
apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

echo "=== factoreye ユーザーを docker グループへ追加 ==="
usermod -aG docker factoreye

echo "=== Cloudflare Tunnel 接続先を :80 に変更 ==="
# 現在の設定は localhost:8000（FastAPI 直接）→ Caddy 経由の localhost:80 に変更
sed -i 's|http://localhost:8000|http://localhost:80|g' /etc/cloudflared/config.yml
systemctl restart cloudflared
echo "cloudflared 再起動完了"

echo "=== デプロイディレクトリ準備 ==="
mkdir -p /opt/factoreye
chown factoreye:factoreye /opt/factoreye

echo ""
echo "=== セットアップ完了。次の手順を factoreye ユーザーで実行してください ==="
echo ""
echo "  sudo -u factoreye bash"
echo "  cd /opt/factoreye"
echo "  git clone https://github.com/hide23link/factoreye.git ."
echo "  cp infra/cloud/.env.cloud.example .env"
echo "  nano .env  # DOMAIN / POSTGRES_PASSWORD / INGEST_API_KEY / JWT_SECRET を設定"
echo "  docker compose -f docker-compose.cloud.yml up -d --build"
echo ""
echo "  # 動作確認"
echo "  curl http://localhost/health"
