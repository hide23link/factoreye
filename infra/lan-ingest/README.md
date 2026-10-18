# LAN 向けの取り込み専用の窓口（nginx）

機器（M5Stack など）から、**センサー値の取り込みだけ**を LAN の中で受ける、小さな窓口（nginx）。
FactorEye の画面・管理者 API・センサーの一覧など、ほかの API は LAN に出さない。
`INGEST_AUTH=off`（キーなしの取り込み、[`docs/decisions.md`](../../docs/decisions.md) 2026-10-18）で動かすときの前提の窓口。

```
機器 ──HTTP──▶ [窓口 nginx: LAN の IP:8001] ──▶ backend（コンテナの中の 8000）
```

**前提: backend の 8000 を、LAN に公開していないこと。** 素の `docker-compose.yml` は 8000 を全インターフェースに公開する（`"8000:8000"`）ので、そのままでは窓口を通らずに、`/api/sensors` や `/api/admin/*` に直接届く（`CF-Connecting-IP` の偽装でレート制限も避けられる）。窓口を使うホストでは、8000 を `127.0.0.1:8000:8000` に絞る（ラズパイは、ホスト固有の設定で絞ってある）。`verify.sh` が、8000 に直接届かないことも確かめる。

| | |
|---|---|
| 通す | `POST /api/ingest/readings`、`GET /health` |
| 断る | それ以外はすべて（`/api/sensors`・`/api/admin/*`・`/docs`・`/` など → 404。通す URL に違うメソッド → 403） |
| 受ける送信元 | 私設アドレス（10.x・172.16〜31.x・192.168.x）と 127.0.0.1 だけ。ルーターのポート転送などでインターネットから届いても、通す 2 つの URL は 403（それ以外の URL は 404、大きすぎる本文は 413。いずれも backend には届かない） |
| 本文の上限 | 256KB（1,000 件のバッチで約 30KB） |
| レート制限 | backend の `INGEST_RATE_LIMIT`（既定 100 回/分）を、**機器ごと**に数える。窓口が、機器の IP を `CF-Connecting-IP` として backend に渡す（機器が付けた値は捨てるので、偽装で避けられない） |

## 使い方（ラズパイなど、OSS 版のホストで）

前提: FactorEye を `INGEST_AUTH=off` で動かしている（そのホストの `.env` に `INGEST_AUTH=off`）。

1. 設定ファイルの文法を確かめる（コンテナを起動する前に）:

   ```bash
   cd ~/apps/factoreye
   docker run --rm -v "$PWD/infra/lan-ingest/nginx.conf:/etc/nginx/conf.d/default.conf:ro" nginx:1.30-alpine nginx -t
   ```

   `syntax is ok` と `test is successful` が出ればよい。

2. 窓口を起動する（`LAN_INGEST_BIND` は、このホストの LAN の IP。`0.0.0.0` にしない。未設定だと 127.0.0.1 になり、LAN の機器からは届かない）:

   ```bash
   LAN_INGEST_BIND=192.168.0.72 docker compose \
     -f docker-compose.yml -f infra/lan-ingest/docker-compose.lan-ingest.yml up -d lan-ingest
   ```

   ポートは `LAN_INGEST_PORT`（既定 8001）。`up -d lan-ingest` は、窓口のコンテナだけを足す（backend などは作り直さない）。

3. いつもの `docker compose up -d --build` でも窓口が付くようにするには、`.env` に次の 2 行を足す（足さないと、更新のたびに上の -f 付きの書き方が要る）:

   ```
   COMPOSE_FILE=docker-compose.yml:infra/lan-ingest/docker-compose.lan-ingest.yml
   LAN_INGEST_BIND=192.168.0.72
   ```

   （区切りは Linux の `:`。Windows は `;`。窓口を持たない別のホストで同じ `.env` を使い回さない。`-f` を付けたコマンドは、`COMPOSE_FILE` より `-f` が優先される）

4. ファイアウォールについて: **Docker が公開したポートには、ufw のルールが効かない**（Docker が iptables に直接書くため）。ufw で許可・拒否しても意味がない。守っているのは、`LAN_INGEST_BIND`（開くインターフェース）と、nginx の送信元の制限（私設アドレスだけ）。LAN の中でさらに絞るなら、`DOCKER-USER` チェインに書く

5. LAN の別のマシン（機器と同じ立場）から確かめる:

   ```bash
   ./infra/lan-ingest/verify.sh http://192.168.0.72:8001
   ./infra/lan-ingest/verify.sh http://192.168.0.72:8001 --rate-test   # レート制限が偽装で避けられないか（約 1 分、制限を使い切る）
   ```

   「すべて期待どおりです」と出ればよい。センサーは作らず、データも増えない（わざと壊した本文を送る）。

6. 機器（FactorEyeNode など）のサーバーアドレスを `http://192.168.0.72:8001` にする。API キーは空でよい。

## 止める・戻す

```bash
docker compose -f docker-compose.yml -f infra/lan-ingest/docker-compose.lan-ingest.yml rm -sf lan-ingest
```

`.env` に足した 2 行も消す。backend は影響を受けない。ログは `docker compose -f docker-compose.yml -f infra/lan-ingest/docker-compose.lan-ingest.yml logs lan-ingest`（`COMPOSE_FILE` を `.env` に足していれば `docker compose logs lan-ingest`）。`/health` はログに残さない。ログは最大 30MB（10MB × 3）まで。

## 注意

- **キーなしの取り込みでは、センサーの `ingestKey` が唯一の資格情報になる**。LAN の中で `ingestKey` を知っている（または当てられる）人は、値を書ける。機器の ID の初期値（`atom-xxxx-temp` など）は推測しやすいので、人が出入りする LAN では、ランダムな文字を含む ID にするとよい
- この窓口は暗号化しない（HTTP）。LAN の中で使う。インターネット経由で送る機器は、別の方法（https）が要る
- 窓口の前（ルーター）で、インターネットへのポート転送をしない。したとしても送信元の制限（上の表）で 403 になるが、前提にしない
- Docker の仕組みで、窓口が見る接続元が機器の IP でなく Docker のゲートウェイの IP（172.x）になる環境では、全機器が 1 つの制限を共有してしまう（Linux の通常の構成では機器の IP が見える）。`docker compose logs lan-ingest` で接続元を確かめる
