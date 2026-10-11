# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
- **データ移行: self-hosted（OSS 版）にも書き出しを追加**: 「設定」→「データ移行」の書き出しが、SaaS だけでなく self-hosted（OSS 版）でも使えるようになった。self-hosted は全データ（`workspace_id` が NULL）を書き出す。既存の「取り込み」と組み合わせ、OSS → OSS（別サーバーへの移行・バックアップ）がアプリ内だけで完結する。OSS → SaaS は引き続き復旧ツールを使う
- **復旧ツール: OSS 版 ⇄ SaaS 版の書き戻し**: OSS 版のバックアップを SaaS 版のワークスペースへ、SaaS 版のワークスペースを OSS 版のデータとして書き戻せる。センサーの ID と取り込みキーは保つ。今の DB の版は `TARGET_MODE`（`saas` / `oss`）で指定する（書き戻しを使うなら必須）
- **復旧ツールの画面を手順形式に**: 「書き戻す」（①バックアップを選ぶ → ②戻すものを選ぶ → ③内容を確認 → ④書き戻す）と「データを見る・書き出す」の 2 つのタブに分けた。バックアップは日時と種類で表示し、選ぶだけで検証・準備する。確認は選び直すたびに自動で行い、追加する件数を文章で示す。閲覧は列名を日本語にし、センサーは名前で、日時は現地時刻で表示する
- **復旧ツールの書き戻し**: 選んだワークスペースについて、バックアップから今の DB に無い行だけを足す。試行（件数の確認、取り消し）と実行は同じ処理。実行の直前に今の DB の控えを取り、1 つのトランザクションで書き込む。`TARGET_WRITE_DATABASE_URL` を設定した場合だけ使える
- **復旧ツール**（`tools/recovery/`）: バックアップを今の DB と見比べ、閲覧・CSV で書き出す Web 画面。FactorEye 本体に依存せず、Docker があればどこでも動く（本番の LXC・ラズパイ・Mac）。読み込み元はディレクトリか S3。sha256 と gzip を検証してから、コンテナの中の作業用の Postgres に展開する。今の DB には読み取り専用で接続する
- **バックアップの拡張**（`infra/backup.sh`）: 各ファイルの隣に sha256 を書く。設定ファイル（`.env`・管理者ファイル・cloudflared の設定）を暗号化して保存できる（`BACKUP_PASSPHRASE_FILE`）。S3 への送信（`infra/offsite-s3.sh`、`OFFSITE_S3_URI`）と、別のマシンからの取得（`infra/offsite-pull.sh`）
- **グラフの時間操作（Grafana と同じ）**: ダッシュボード上部で、過去への移動（前へ・後ろへ）、現在への復帰（今）、拡大・縮小、プリセット（直近 5 分〜30 日）と任意の期間を選べる。グラフ上のドラッグで、その期間に拡大する。範囲は URL（`?range=1h` / `?from=…&to=…`）に保持する。SaaS は 90 日まで
- **グラフ用の間引き API**: `GET /api/sensors/{id}/readings/downsampled`（`from` / `to` / `buckets`）。区間ごとの最小・平均・最大・件数を返す。`SensorGraph` と `MultiSensorComparison` はこれを使う
- **取り込みのレート制限を、管理画面から期限付きで解除**: 管理画面の上部のカードで「60 分だけ解除」「今すぐ制限を戻す」を操作できる。期限（既定 60 分・最長 240 分）を過ぎると自動で既定の制限に戻る。状態はメモリのみ（再起動で既定に戻る）。`GET` / `PUT /api/admin/ingest-limit`
- **SaaS → OSS の移行**: SaaS のワークスペースを書き出し（設定画面「データ移行」）、OSS の DB に取り込む（同じ画面・CLI）。ID と取り込みキーを保つ。測定値は差分の配列で圧縮（形式の版 2）。取り込みは1トランザクション、`dry_run` で件数を確認可能
- **Webhook 連携**: センサー値の受信（`reading.received`）とアラーム発生（`alarm.triggered`）を、任意の URL へ JSON で送信。設定は設定画面の「Webhook連携」タブ
- **送信先の制限（SSRF 対策）**: Webhook の送信先は `https` かつ公開 IP のみ。登録時と送信時に検証する。社内ネットワーク向けの例外は `WEBHOOK_ALLOW_PRIVATE_NETWORKS=true`（既定 `false`）
- **管理者画面**（`/admin`、SaaS 版の運用者向け）: 件数の確認、ユーザーの閲覧・修正・削除
- **取り込みのレート制限の解除モード**（`INGEST_RATE_LIMIT=off`）: 実機・負荷テスト用。起動時に警告を出す
- **負荷テスト用エミュレータ**（`loadtest/`）
- **SaaS の Free Tier**: 測定値を 90 日より古いものから毎日削除（SaaS のセンサーのみ対象）。上限到達時の案内を画面に表示

### Changed
- **未使用の `widget_configs` テーブルを削除**: ウィジェットの設定は `widgets.config` に持つため不要だった（本番・OSS 版とも 0 件）。マイグレーション `e5f6a7b8c9d0` で drop する（downgrade で空のテーブルを再作成）。SaaS → OSS の書き出し・取り込みと復旧ツールの対象からも外した。スキーマの版が変わるため、復旧ツールの書き戻し・マージは、このマイグレーション適用前（版 `d4e5f6a7b8c9`）のバックアップを、適用後の DB には使えない（同じ版どうしに限る）。適用前のバックアップは、`infra/restore.sh` で丸ごと戻したあと、アプリを起動すると `alembic upgrade head` が走って `widget_configs` が削除される
- **バックアップのファイルの権限を 640 に**（従来は 644）。利用者のデータとパスワードのハッシュが入るため。復旧ツールはグループの権限で読む
- **Webhook の送信に上限を設定**: 接続を使い回し、同時送信は 10 件まで、送信待ちは 1,000 件まで（超えた分は送らずに捨て、ログに件数を出す）。大量の取り込みや送信先の遅延で、CPU・メモリ・接続を使い切らないため
- ドキュメントを整理し、仕様書を `docs/architecture.md`、設計判断を `docs/decisions.md` にまとめた
- **Docker イメージを軽量化**: frontend は 428 MB → 63 MB（Vite preview をやめ、ビルド済みの静的ファイルを nginx で配信。多段ビルド）、backend は 421 MB → 283 MB（多段ビルド、実行時依存と開発用依存（`requirements-dev.txt`）を分離、`.dockerignore` に tests などを追加）
- センサー名の一意性を、ワークスペース内に変更（従来は DB 全体で一意）
- 通知設定をワークスペースごとに持つように変更（従来は ID=1 の1行に固定）
- アラーム一覧 API（`GET /api/alarms`）に `limit`（1〜500、省略時は全件）と `offset` を追加。`total` は、ページで区切る前の件数。警告ウィジェットは状態ごとに新しい順 100 件まで取得する（応答が大きく、サーバーの CPU を使っていたため）
- センサー一覧（`GET /api/sensors`）に ETag を付け、変わっていなければ 304 を返す。版（ETag）ごとに応答をメモリに持ち、版が変わらない間は読み出しも変換もやり直さない。一覧の応答は ORM を通さず 1 回だけ JSON にする（画面の数秒ごとの取り直しの CPU を減らすため）
- 測定値・アラームの一覧の応答を、1 回だけ JSON にし、必要な列だけ読むように変更（CPU の使用を減らすため。応答の形は変わらない）
- **【起動条件の変更】本番で既定の秘密値のままだと起動しない**: `ENVIRONMENT=production` のとき、`INGEST_API_KEY`（self-hosted）または `JWT_SECRET`（`AUTH_MODE=multi_tenant`）が既定値 `change-this-in-production` のままだと、起動時にエラーにする。`.env.example` の `ENVIRONMENT=production` はコメントアウトに変更した。本番にするときは、値を変えてからコメントを外すこと
- `docker-compose.cloud.yml`: `DOMAIN` / `POSTGRES_PASSWORD` / `INGEST_API_KEY` / `JWT_SECRET` が未設定だと、空文字で起動せず、エラーで止める
- **【変更】`docker-compose.yml`: PostgreSQL のポートを `127.0.0.1:5432` だけに公開**（従来は LAN に公開）。LAN 内の別ホストから直接 `psql` などで接続している場合は、接続できなくなる
- 取り込み API: `NaN` / `Infinity` の値と、1 リクエスト 1,000 件を超える `readings` を 400 で拒否する。UTF-8 でない本文も 500 でなく 400 を返す

### Fixed
- デバイスクライアント（Raspberry Pi・Arduino/M5Stack）の再送を修正: 400・422 などの再送しても成功しない応答で値を捨てるようにした（これまでは 1 件の不正値で、そのセンサーが最大 100 件分の間送れなくなっていた）。NaN・無限大は送る前に捨てる。429 は `Retry-After` に従う。401・403・404 は値を保持して再送する
- 取り込みの API キー（`X-API-Key`）の照合を、一定時間で比較する方法（`hmac.compare_digest`）に変更（比較時間からキーを推測されないため）
- 停止時（再起動・デプロイ）に、バッファに残った測定値（最大 1 秒分）を書かずに終了していた問題を修正。終了前に書き込む
- 取り込みバッファの DB 書き込みに失敗すると、その周期の測定値が消えていた問題を修正。失敗した値はバッファに戻し、次の周期で再試行する（再試行待ちは最大 10 万件）。受信後に削除されたセンサーの値は捨て、バッチ全体の失敗を防ぐ
- マルチテナントで、別のワークスペースが同じセンサー名を使えない問題を修正
- マルチテナントで、アラームの Discord 通知が、そのワークスペースの設定でなく ID=1 の設定で送られる問題を修正
- 取り込みキーが別のワークスペースと衝突したとき、500 ではなく 409 を返すように修正
- 直近モードのグラフが 30 秒ごとでなく毎秒取り直される問題を修正（描画のたびの現在時刻を、取り直しの間隔に合わせた値にした。応答が遅い環境で起きやすかった）

### Removed
- **【破壊的変更】Python プラグインシステムを廃止**: `/api/plugins` API、設定画面の「プラグイン」タブ、`plugins` / `plugin_configs` テーブルを削除（マイグレーション `c3d4e5f6a7b8`）。プラグインの設定値は失われる。拡張は Webhook で行う

---

## [0.1.0] - 2026-10-04

Phase 0 + Phase 0.5 — self-hosted 工場監視 OSS の MVP と、SaaS Free Tier の認証基盤を同梱した初回リリース。

### Added (Phase 0.5 — SaaS Free Tier)

#### 認証基盤（`AUTH_MODE=multi_tenant`）
- ユーザー登録・ログイン・ログアウト（JWT のアクセストークン 15 分、リフレッシュトークン 30 日）
- リフレッシュトークンのローテーション（旧トークンは即時失効）
- ワークスペース分離（センサー・ダッシュボード・通知設定をワークスペース単位で隔離）
- Free Tier の制限: ワークスペースあたりセンサー最大 10 個（超過時は HTTP 402）
- フロントエンドの認証画面（新規登録・ログイン）

#### 本番デプロイ基盤
- `docker-compose.cloud.yml`: Caddy（リバースプロキシ）+ backend + frontend + PostgreSQL
- Cloudflare Tunnel 経由の HTTPS 公開（TLS 証明書の管理は不要）
- GitHub Actions のセルフホストランナーによる `main` への push での自動デプロイ
- `infra/cloud/setup-server.sh`: Ubuntu 24.04 への Docker と Cloudflare Tunnel の初期設定

### Added (Phase 0 MVP — self-hosted 工場監視 OSS)

#### センサー・計測値
- REST Ingest API（`POST /api/ingest/readings`）。APIキーで認証
- 受信バッファ（1 秒ごとのバッチ書き込み）
- センサーの CRUD（名前・Ingest Key・単位・有効/無効）
- 2 段階のしきい値: 軽故障（warning）と重故障（critical）× 上限・下限をそれぞれ独立に設定
- 不感帯（ヒステリシス）でしきい値付近のアラームのチラつきを防止

#### アラーム
- しきい値の超過を自動評価してアラームを生成（重要度: warning / critical）
- アラームの確認（acknowledge）
- Discord Webhook による通知（重故障と軽故障を別チャンネルに送り分け。重故障は通常送信、軽故障はサイレント送信）
- 重故障の再通知（未解決のまま一定時間経過した場合）
- 発生時刻・通知時刻を日本時間で表示

#### ダッシュボード・ウィジェット
- ダッシュボードの作成・削除・設定（名前・説明）
- ドラッグ＆リサイズ可能なウィジェットグリッド（react-grid-layout）
- **SensorGraph**: 折れ線・棒・面グラフ。色・Y 軸の範囲・時間窓を設定可能
- **AlarmAlert**: 発生中のアラーム一覧と確認ボタン
- **ProductionStatus**: 稼働 ON/OFF、直近 1 時間と本日の生産数、目標達成率
- **MultiSensorComparison**: 複数センサーの重ね合わせ比較
- **StatValue**: 最新値の大きな表示とスパークライン。しきい値に応じた色分け

#### セットアップ・運用
- 5 分セットアップガイド: センサー登録 → テスト送信 → ダッシュボード自動作成
- Docker Compose による一括起動（`docker compose up -d --build`）
- DB のバックアップ・復元スクリプト（`infra/backup.sh` / `infra/restore.sh`）

#### 公式クライアント
- Arduino / M5Stack クライアント（`clients/arduino-m5stack/`）
- Raspberry Pi クライアント（`clients/raspberry-pi/`）
- テスト用の工場エミュレータ（`tools/factory-emulator/`、手動操作画面つき）

### Quality & CI
- Backend: pytest・mypy・ruff・pip-audit（GitHub Actions）
- Frontend: Vitest（カバレッジ閾値つき）・ESLint・tsc・npm audit
- E2E: Playwright（セットアップウィザードと、アラームの発生・確認の 2 シナリオ）

### Infrastructure
- PostgreSQL 15（本番・テストともに）
- GitHub Actions による CI（backend / frontend / E2E / Arduino・Raspberry Pi クライアント）

---

*以降のリリースではこのファイルに追記してください。*
