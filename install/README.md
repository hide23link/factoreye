# 導入と運用

## Ubuntu / Raspberry Pi

```bash
curl -fsSL https://raw.githubusercontent.com/hide23link/factoreye/main/install/install.sh | sudo bash
```

もう一度実行すると、データと設定を残したまま更新します（更新前に自動でバックアップを取ります）。

| やりたいこと | 方法 |
|---|---|
| 設定を変える | 画面の **設定 → API・取り込み**（管理パスワードが必要）。または `/opt/factoreye/config/.env` を編集し、同じ画面の「ファイルの内容を反映」を押す |
| 管理コマンド | `cd /opt/factoreye && ./factoreye.sh`（`status` / `logs` / `update` / `backup` / `set-password` / `restore-env`） |
| 動作確認 | `./smoke-test.sh http://<IP>:3001 '<管理パスワード>'` |
| 削除 | `cd /opt/factoreye && docker compose --env-file config/.env down -v && cd / && sudo rm -rf /opt/factoreye /etc/cron.d/factoreye`（データも消えます） |

設定ファイルは `/opt/factoreye/config/.env` の 1 つです。ひな形は `.env.template` です。秘密の値（`JWT_SECRET`・DB パスワード）は、このファイルでだけ変えます。

## Mac / Windows（Docker Desktop）

```bash
mkdir factoreye && cd factoreye
curl -fsSLO https://raw.githubusercontent.com/hide23link/factoreye/main/install/docker-compose.yml
curl -fsSLO https://raw.githubusercontent.com/hide23link/factoreye/main/install/.env.template
mkdir config && cp .env.template config/.env
```

Windows の PowerShell では `curl` を `curl.exe` に読み替えてください。`config/.env` の `__GENERATE__` の 4 か所を長いランダムな文字列に置き換え（`DATABASE_URL` のパスワードと `POSTGRES_PASSWORD` は同じ値）、起動します。

```bash
docker compose --env-file config/.env up -d
```

画面は http://localhost:3001 です。

## インターネットへの公開

出す口は、画面を配る nginx の 3001 番だけです（`/api` と `/health` は nginx が backend へ転送します。DB と backend は出しません）。配布版の nginx は **HTTPS に対応していません**。外に出すときは、前段で HTTPS にします。

| 方法 | 向く場面 | 要点 |
|---|---|---|
| Cloudflare Tunnel | ポートを開けたくない | サーバーで `cloudflared` を動かし、公開ホスト名を `http://localhost:3001` に向ける。HTTPS は Cloudflare が担当。画面は Cloudflare Access で保護できる |
| AWS（EC2・Lightsail） | クラウドで動かす | 同じ `install.sh` で導入。前段に ALB + ACM、または Caddy（Let's Encrypt）を置く。セキュリティグループは 80/443 だけ開ける（例。手順は環境により異なる） |
| VPN（Tailscale など） | 社内の人だけが見る | ポートを開けず、VPN 内から `http://<VPN の IP>:3001` を開く |
| Caddy / nginx + 固定 IP | 固定 IP とドメインがある | 前段にもう 1 つ置き、`reverse_proxy localhost:3001` と書くだけで HTTPS になる |

どの方法でも守ること:

- `config/.env` の `FRONTEND_URL` を、外から開く URL にする
- 画面と取り込み以外の API には認証がありません。**画面は認証の内側（Cloudflare Access や VPN）に置き**、外に直接出すのは `/api/ingest` だけにする
- 外から取り込みを受けるときは、`INGEST_AUTH=key` のまま、機器ごとのキー（`X-Device-Key`）で送る。HTTPS 必須

## 注意

`INGEST_AUTH=off`（キーなしの取り込み）にするときは、取り込みの口を LAN に限定してください。
