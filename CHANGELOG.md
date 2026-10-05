# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added
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
- ドキュメントを整理し、仕様書を `docs/architecture.md`、設計判断を `docs/decisions.md` にまとめた
- センサー名の一意性を、ワークスペース内に変更（従来は DB 全体で一意）
- 通知設定をワークスペースごとに持つように変更（従来は ID=1 の1行に固定）

### Fixed
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
