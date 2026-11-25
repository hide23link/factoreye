# LAN 向けの取り込み専用の窓口（nginx）

機器（M5Stack など）から、**センサー値の取り込みだけ**を LAN の中で受ける小さな窓口です。画面・設定・センサー一覧など、ほかの API は LAN に出しません。
`INGEST_AUTH=off`（キーなしの取り込み）で動かすときの前提の窓口です。

```
機器 ──HTTP──▶ [窓口 nginx: LAN の IP:8001] ──▶ backend（コンテナの中の 8000）
```

**前提: backend の 8000 番を LAN に公開しないこと。** 素の `docker-compose.yml` は 8000 番を全インターフェースに公開するので、そのままでは窓口を通らずに `/api/sensors` などへ直接届きます。窓口を使うホストでは `.env` に `FE_BIND_HOST=127.0.0.1` を書きます（`verify.sh` が、8000 番に直接届かないことも確かめます）。

| | |
|---|---|
| 通す | `POST /api/ingest/readings`、`GET /health` |
| 断る | それ以外はすべて（404。通す URL に違うメソッドは 403） |
| 受ける送信元 | 私設アドレス（10.x・172.16〜31.x・192.168.x）と 127.0.0.1 だけ。インターネットから届いても 403 |
| 本文の上限 | 取り込みは 8MB（`samples` のまとめ送りの最大に合わせた値）、それ以外は 256KB |
| レート制限 | backend の `INGEST_RATE_LIMIT`（既定 100 回/分）を**機器ごと**に数える。窓口が機器の IP を `CF-Connecting-IP` として渡す（機器が付けた値は捨てるので、偽装で避けられない） |

## 使い方

1. 設定ファイルの文法を確かめる:

   ```bash
   docker run --rm -v "$PWD/infra/lan-ingest/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30-alpine nginx -t
   ```

2. 窓口を起動する（`LAN_INGEST_BIND` はこのホストの LAN の IP。`0.0.0.0` にしない。ポートは `LAN_INGEST_PORT`、既定 8001）:

   ```bash
   LAN_INGEST_BIND=192.168.0.10 docker compose \
     -f docker-compose.yml -f infra/lan-ingest/docker-compose.lan-ingest.yml up -d lan-ingest
   ```

3. いつもの `docker compose up -d --build` でも窓口が付くよう、`.env` に次の 2 行を足す（区切りは Linux は `:`、Windows は `;`）:

   ```
   COMPOSE_FILE=docker-compose.yml:infra/lan-ingest/docker-compose.lan-ingest.yml
   LAN_INGEST_BIND=192.168.0.10
   ```

4. LAN の別のマシンから確かめる（センサーは作らず、データも増えない）:

   ```bash
   ./infra/lan-ingest/verify.sh http://192.168.0.10:8001
   ./infra/lan-ingest/verify.sh http://192.168.0.10:8001 --rate-test   # レート制限が偽装で避けられないか（約 1 分）
   ```

5. 機器のサーバーアドレスを `http://192.168.0.10:8001` にする。API キーは空でよい

止めるときは `docker compose -f docker-compose.yml -f infra/lan-ingest/docker-compose.lan-ingest.yml rm -sf lan-ingest` を実行し、`.env` に足した 2 行を消します。

## 注意

- **Docker が公開したポートには、ufw のルールが効きません**（Docker が iptables に直接書くため）。守っているのは `LAN_INGEST_BIND` と nginx の送信元の制限です。さらに絞るなら `DOCKER-USER` チェインに書きます
- キーなしの取り込みでは、センサーの `ingestKey` が唯一の資格情報です。人が出入りする LAN では、推測しにくい ID にします
- この窓口は暗号化しません（HTTP）。インターネット経由で送る機器は、HTTPS と機器ごとのキー（[`docs/device-keys.md`](../../docs/device-keys.md)）を使います
- ルーターでインターネットへのポート転送をしないでください
