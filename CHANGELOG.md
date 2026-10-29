# Changelog

この形式は [Keep a Changelog](https://keepachangelog.com/ja/1.1.0/) に、バージョンは [Semantic Versioning](https://semver.org/lang/ja/) に従います。

---

## [Unreleased]

### Added
- **管理画面（SaaS）から復旧**: 「R2 から復旧する」（WAL-G のバックアップから本番に無い行を足す）と「書き戻し」（控え（AWS）の引き継ぎを足す）。どちらも試算 → 確認 → 実行の順
- **復旧ツール**（`tools/recovery/`）: バックアップを今の DB と見比べ、閲覧・CSV 書き出し・書き戻しをする Web 画面。OSS 版 ⇄ SaaS 版の書き戻しに対応
- **バックアップの拡張**（`infra/backup.sh`）: sha256、設定ファイルの暗号化保存、S3 への送信（`offsite-s3.sh`）、別のマシンからの取得（`offsite-pull.sh`）
- **LAN 向けの取り込み専用の窓口**（`infra/lan-ingest/`）: `POST /api/ingest/readings` と `GET /health` だけを LAN に通す nginx
- **キーなしの取り込み**（`INGEST_AUTH=off`、self-hosted）
- **未登録の ingestKey を自動で作る**（`INGEST_AUTO_CREATE=on`、self-hosted。既定 off）
- **self-hosted の書き出し**: 「データ移行」で全データを書き出し、OSS → OSS をアプリ内で完結
- **SaaS → OSS の移行**（書き出しを差分の配列で圧縮。取り込みは 1 トランザクション、`dry_run` あり）
- **Webhook 連携**（`reading.received`・`alarm.triggered`）と送信先の検証（SSRF 対策）
- **管理者画面**（`/admin`）: 件数、利用者の閲覧・変更・削除、利用者として閲覧（期限付き）、取り込みのレート制限の期限付き解除
- **グラフの時間操作**: 前後への移動、今に戻る、拡大縮小、プリセットと任意の期間、ドラッグで拡大。範囲は URL に保持（SaaS は 14 日まで）
- **グラフ用の間引き API**: `GET /api/sensors/{id}/readings/downsampled`
- **ダッシュボードの部品と編集操作**: ゲージ（`Gauge`）、生産管理（`ProductionPlan`）、稼働ステータスのカード表示、しきい値の余裕バー、センサー選択画面、グラフの設定項目の追加、棚と設定パネルの移動、Ctrl/⌘+Z で元に戻す、新規作成時の型の選択
- **負荷テスト用エミュレータ**（`loadtest/`）、**工場エミュレータ**の手動操作画面（`tools/factory-emulator/`）
- **デバイスクライアント**: Arduino の `setSensorInfo`（名前と単位の結びつけ）、キーなし送信への対応

### Changed
- **【API の変更（互換性なし）】測定値の主キーを `(sensor_id, recorded_at)` にし、連番の `id` を廃止**（マイグレーション `g7b8c9d0e1f2`）。測定値の応答から `id` を外した。1 行 161 B → 101 B。既存データは 1 行も捨てずに移す。**アプリを止めて適用し、readings の 2 倍程度の空きを要する**（`infra/check-migration-space.sh` で確かめる）
- **SaaS の測定値の保持を 90 日から 14 日に**（self-hosted は無期限のまま）。DR のバックアップ量と復旧時間を小さくするため
- **通知設定をワークスペースごとに持つ**（従来は ID=1 の 1 行に固定）
- **センサー名の一意性をワークスペース内に**（従来は DB 全体）
- **アラーム一覧 API に `limit`（1〜500）と `offset`**。`total` はページで区切る前の件数。既定の動きは全件のまま
- **センサー一覧に ETag**（変わっていなければ 304）。一覧の応答は ORM を通さず 1 回だけ JSON にする
- **画面の初期読み込みを軽くした**（遅延読み込み。初期の転送量は 785 KB → 203 KB）
- **稼働ステータスの通信量と、取り込みの DB 読み込みを減らした**（結果は変わらない）
- **Docker イメージの縮小**: frontend 428 → 63 MB、backend 421 → 283 MB、復旧ツール 512 → 299 MB
- **【起動条件】本番で既定の秘密値のままだと起動しない**（`ENVIRONMENT=production`）。`docker-compose.cloud.yml` は `DOMAIN`・`POSTGRES_PASSWORD`・`INGEST_API_KEY`・`JWT_SECRET` が未設定だと止まる
- **【変更】`docker-compose.yml` の PostgreSQL を `127.0.0.1:5432` だけに公開**（従来は LAN に公開）。LAN から直接 `psql` で接続していた場合は接続できなくなる
- **取り込み API**: `NaN`・`Infinity` と、1,000 件を超える `readings` を 400 で拒否。UTF-8 でない本文も 400
- **バックアップのファイルの権限を 640**（従来は 644）

### Fixed
- **パスワードが 72 バイトを超えると 500 になる**: 登録・変更は 422、ログインは 401。422 の応答に、送られたパスワードを含めない
- **登録・ログインの bcrypt が、同じプロセスの他の要求を止めていた**: 別スレッドで、同時 4 件に制限
- **期限切れのリフレッシュトークンが増え続けていた**: 期限から 7 日後に毎日削除
- **メールの大文字小文字が別のアカウントになっていた**: 前後の空白を除き小文字にして扱う。`lower(email)` の一意インデックスを追加（既存の重複があると、マイグレーションは何も削除せずに失敗する）
- **ログインの応答時間で、登録の有無が分かっていた**: 未登録でもパスワードの照合を行い、時間をそろえる
- **ログアウトでサーバー側のリフレッシュトークンを失効させていなかった**
- **取り込みの DB 書き込みに失敗すると、その周期の値が消えていた**: 値をバッファに戻して再試行する（上限 10 万件）。停止時も、バッファを書いてから終了する
- **マルチテナントで、アラームの Discord 通知が ID=1 の設定で送られていた**
- **マルチテナントで、別のワークスペースと同じセンサー名・取り込みキーを使うと 500 になっていた**: 409 を返す
- **更新 API で null を許さない項目に null を送ると、以降の一覧・詳細が 500 になっていた**: 422 を返す
- **ウィジェットの作成・更新で、存在しない・他のワークスペースのセンサー ID を指定できた**: 404 を返す
- **測定値の `from`・`to` にタイムゾーンの無い日時を渡すと 500**: 422 を返す
- **マイグレーションで作った DB で、通知設定の最初の作成が主キー重複で 500**（マイグレーション `f6a7b8c9d0e1`）
- **Discord・Webhook の URL（トークンを含む）がログに出ていた**: ホスト名と失敗の理由だけを記録する
- **データ取得に失敗すると「読み込み中…」のまま止まっていた**: エラーと再試行ボタンを表示する
- **デバイスクライアントの再送**: 400・422 で値を捨てるようにし、NaN・無限大は送る前に捨てる。401・403・404 は保持して再送する
- **`tools/factory-emulator` の手動操作画面が、認証なしで全ネットワークに公開されていた**: 既定は `127.0.0.1`
- **復旧ツールの画面と CSV に Webhook の URL が平文で出ていた**: ホスト名と末尾 4 文字だけにする
- **OSS 版で `restart: unless-stopped` が無く、再起動後に復帰しなかった**
- **OSS 版で `INGEST_RATE_LIMIT` が backend に渡らず、`.env` に書いても効かなかった**
- **ログイン・管理者ログインの失敗理由が、生の HTTP エラーや一律の「パスワード誤り」だった**: 理由を分けて日本語で表示する
- その他: 画面の入力確認（センサーのしきい値の大小など）、セッション更新の同時実行、直近モードのグラフが毎秒取り直される問題、期間の指定で NaN になる問題、ダッシュボード名の古い表示、CI の E2E レポートとトレース、`infra/README.md` の cron 例（`COMPOSE_FILE`）

### Removed
- **【破壊的変更】Python プラグインシステムを廃止**: `/api/plugins`、「プラグイン」タブ、`plugins` / `plugin_configs` テーブル（マイグレーション `c3d4e5f6a7b8`）。設定値は失われる。拡張は Webhook で行う
- **未使用の `widget_configs` テーブル**（マイグレーション `e5f6a7b8c9d0`）。適用前のバックアップは、適用後の DB に書き戻せない

---

## [0.1.0] - 2026-10-04

初回リリース。self-hosted の工場監視 OSS の MVP と、SaaS Free Tier の認証基盤を含む。

### Added
- **取り込み**: `POST /api/ingest/readings`（API キーで認証、1 秒ごとのバッチ書き込み）
- **センサーとアラーム**: 上限・下限 × 軽故障・重故障の 4 項目、不感帯、確認（ack）、Discord 通知（重故障は通常送信、軽故障はサイレント、重故障の再通知）
- **ダッシュボード**: ドラッグ・リサイズできる格子。SensorGraph・AlarmAlert・ProductionStatus・MultiSensorComparison・StatValue
- **セットアップ**: 5 分のガイド（センサー登録 → テスト送信 → ダッシュボード作成）、`docker compose up -d --build` で一括起動、`infra/backup.sh` と `infra/restore.sh`
- **公式クライアント**: Arduino / M5Stack（`clients/arduino-m5stack/`）、Raspberry Pi（`clients/raspberry-pi/`）、工場エミュレータ（`tools/factory-emulator/`）
- **SaaS の基盤**（`AUTH_MODE=multi_tenant`）: 登録・ログイン（JWT、リフレッシュトークンのローテーション）、ワークスペース分離、Free Tier（センサー 10 個まで）、登録・ログイン画面
- **本番デプロイの基盤**: `docker-compose.cloud.yml`、Cloudflare Tunnel による HTTPS、GitHub Actions の自動デプロイ

### Quality & CI
- backend: pytest・mypy・ruff・pip-audit。frontend: Vitest・ESLint・tsc・npm audit。E2E: Playwright（2 シナリオ）
- PostgreSQL 15 を、本番・テストともに使う

---

*以降のリリースではこのファイルに追記してください。*
