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

## 注意

`INGEST_AUTH=off`（キーなしの取り込み）にするときは、取り込みの口を LAN に限定してください。
