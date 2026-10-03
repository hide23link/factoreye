# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [0.1.0] - 2026-10-04

Phase 0 + Phase 0.5 — self-hosted工場監視OSSのMVPと、SaaS Free Tierの認証基盤を同梱した初回リリース。

### Added (Phase 0.5 — SaaS Free Tier)

#### 認証基盤（AUTH_MODE=multi_tenant）
- ユーザー登録・ログイン・ログアウト（JWT アクセストークン 15分 + リフレッシュトークン 30日）
- リフレッシュトークンローテーション（旧トークンは即時失効）
- Workspace 分離（マルチテナント: センサー・ダッシュボード・通知設定を workspace 単位で隔離）
- Free Tier 制限: 1ワークスペースあたりセンサー最大10個（超過時 HTTP 402）
- フロントエンド認証 UI（新規登録・ログイン切り替え、「センサー10個まで永続無料」表示）

#### 本番デプロイ基盤
- `docker-compose.cloud.yml`: Caddy リバースプロキシ + backend + frontend + PostgreSQL
- Cloudflare Tunnel 経由で HTTPS 公開（TLS 証明書管理不要）
- GitHub Actions セルフホストランナーによる `main` push 自動デプロイ（約24秒）
- `infra/cloud/setup-server.sh`: Ubuntu 24.04 への Docker + Cloudflare Tunnel 初期設定スクリプト

### Added (Phase 0 MVP — self-hosted工場監視OSS)

### Added

#### センサー・計測値管理
- REST Ingest API（`POST /api/ingest/readings`）— APIキー認証付きセンサーデータ受信
- 受信バッファ（1秒毎バッチフラッシュ）でDB書き込みを最適化
- センサー CRUD（名前・Ingest Key・単位・有効/無効）
- 2段階しきい値: 軽故障（warning）/重故障（critical）× 上限/下限それぞれ独立設定
- 不感帯（DeadBand）設定でしきい値付近のアラームチラつき防止

#### アラーム
- しきい値突破を自動評価しアラーム生成（backend alarm_engine）
- アラーム重要度（severity: warning / critical）に対応
- アラーム確認（acknowledge）フロー
- Discord Webhook 通知（重故障/軽故障を別チャンネルに送り分け）
- 重故障: 通常送信（通知音あり）、軽故障: サイレント送信
- 重故障の再通知機能（未解決のまま一定時間経過したら再送）
- 発生時刻・通知時刻を JST で表示

#### ダッシュボード & ウィジェット
- ダッシュボード作成・削除・設定（名前・説明）
- ドラッグ＆リサイズ可能なウィジェットグリッド（react-grid-layout）
- **SensorGraph** ウィジェット: 折れ線/棒/面グラフ、色・Y軸範囲・時間窓カスタマイズ
- **AlarmAlert** ウィジェット: アクティブアラーム一覧・確認ボタン
- **ProductionStatus** ウィジェット: 稼働ON/OFF・直近1時間と本日累計の生産数・目標達成率
- **MultiSensorComparison** ウィジェット: 複数センサーを重ね合わせた比較グラフ
- **StatValue** ウィジェット: Grafana Stat 風の最新値大表示＋スパークライン、しきい値に応じた色分け

#### プラグインシステム
- プラグイン一覧・有効/無効切り替え・config JSON 編集 UI
- `on_reading` フックで新規センサー値受信時にカスタム処理を実行可能

#### セットアップ & 運用
- 5分セットアップガイド（SetupWizard）: センサー登録→テスト送信→ダッシュボード自動作成
- Docker Compose ワンコマンド起動（`docker compose up -d --build`）
- DBバックアップ・リストアスクリプト（`infra/backup.sh` / `infra/restore.sh`）

#### 公式クライアントライブラリ
- Arduino/M5Stack クライアント（`clients/arduino-m5stack/`）
- Raspberry Pi Python クライアント（`clients/raspberry-pi/`）
- テスト工場エミュレータ（`tools/factory-emulator/`、手動操作 Web UI 付き）

### Quality & CI
- Backend: pytest / mypy / ruff / pip-audit（GitHub Actions）
- Frontend: Vitest（74テスト、カバレッジ全指標 50% 以上）/ ESLint / tsc / npm audit
- E2E: Playwright（セットアップウィザード・アラーム発生/確認の2シナリオ）
- Ingest API: 認証・不正ペイロード・高頻度バッチ・disabled センサーを網羅

### Infrastructure
- PostgreSQL 15（本番）/ SQLite（テスト）
- Alembic マイグレーション（冪等）
- GitHub Actions CI（backend / frontend / E2E / Arduinoクライアント / RPiクライアント）

---

*以降のリリースではこのファイルに追記してください。*
