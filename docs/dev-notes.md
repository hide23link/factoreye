# 開発ノート

このファイルはAI(Claude Code)との開発セッションで決まった作業方針・変更履歴を記録する。
仕様そのものは `docs/factoreye-architecture.md` を参照。ここは運用メモ用。

---

## 作業時の方針

- **コマンドライン実行中のコメント（Bashツールの説明文）は日本語で、なるべくわかりやすく書く**
  （2026-10-01、社長からの指示）

---

## 変更履歴

### 2026-10-01: ダッシュボードUI自由化（配置・サイズ・グラフ軸）

**背景**: Sprint 5で実装したダッシュボードUIが、配置（隣同士の入れ替えのみ）・サイズ（幅1-3のドロップダウンのみ）・グラフの横軸/縦軸（固定プリセットのみ、縦軸は設定UIすら無し）の面で制約が強すぎるとのフィードバック。

**対応**:
- 配置・リサイズ: 自作のCSS Grid + dnd-kitから `react-grid-layout` に置き換え。マウスドラッグで好きな位置へ自由配置、角をドラッグして自由リサイズ（1〜12列グリッドに拡張、以前は3列固定）
- グラフ横軸: 固定プリセット（1h/6h/24h/7d）→「直近 N 時間」の自由数値入力に変更
- グラフ縦軸: 最小値/最大値を編集できるUIを新規追加（空欄＝自動スケール）
- ウィジェット編集機能を新規追加（⚙編集ボタン）。従来は作成時にしか設定できなかったセンサー・軸設定を、作成後もいつでも変更可能に

**確認方法**: 実際にdocker-composeで起動し、ブラウザ（Chrome）で本物のダッシュボードを操作して検証済み（ドラッグ移動・リサイズ・軸編集、すべてAPI経由でDBに保存されることまで確認）。

**関連コミット**: `9744142` (factoreyeリポジトリ)

---

### 2026-10-02: Plugin System 基盤実装（Sprint 6 backend prerequisite）

**背景**: `docs/factoreye-architecture.md` のロードマップ通りSprint 6（Plugin System & Configuration UI）に着手。Sprint 5と同様、まずbackend基盤から実装し、フロントエンド（Plugin設定UI・Quick setup wizard・Sensor/Alarm/Dashboard設定画面）は次回に分離。

**実装内容**:
- `app/plugins/base.py`: `FactorEyePlugin`（構造的Protocol）と、全フックがno-opの`BasePlugin`（プラグイン作者はこれを継承すれば必要なフックだけ書けば済む）
- `app/plugins/registry.py`: `app/plugins/installed/` 配下をスキャンしてdiscovery（1プラグイン作者の不具合で起動全体を落とさないようtry/exceptでスキップ）
- `app/plugins/manager.py`: discover→DB行upsert→enabled分のstart、`/api/plugins/:name/*` へのroutesマウント、`on_reading` dispatch。`load_plugins()`は冪等（同じインスタンスに複数回呼んでも二重マウント・二重起動しない）
- `app/api/plugins.py`: `GET /api/plugins`（一覧）、`PATCH /api/plugins/:name/enable`・`/disable`、`PUT /api/plugins/:name/config`
- `app/ingest_buffer.py`: バッチflush（DB commit）後に全startedプラグインへ`on_reading`を発火するよう接続
- サンプルプラグイン `app/plugins/installed/reading_logger/`: lifecycle・routes・widgetsの最小実装例（受信Reading数を`/api/plugins/reading_logger/stats`で返すだけ）

**ドキュメントとの食い違いの解決**（`docs/factoreye-architecture.md` 側は未更新、要反映）:
- ライフサイクル図は新規プラグイン発見時に`enabled=true`でDB挿入と書いているが、`db/models.py`の`Plugin.enabled`デフォルトは`False`。サンドボックスがない（既知のリスクとして明記済み）以上、未知のプラグインを自動的に有効化するのは安全側ではないため、**モデルのデフォルト（enabled=False、要`PATCH .../enable`での明示的な有効化）を正とした**。
- プラグイン名の例は`slack-notifier`のようなkebab-caseだが、フォルダ名はPythonパッケージとしてimportする関係上、本実装は`reading_logger`のようなsnake_caseを採用（フォルダ名とplugin.nameは完全一致が必須、registry.pyで検証）。

**既知の制限（Phase 0で許容、ドキュメント§既知のリスクと整合）**:
- `disable`してもFastAPIの制約でHTTPルート自体は登録解除されない（on_reading配送だけ止まる）。再起動まではエンドポイントが残る。
- サンドボックスなし（ドキュメント通り）。例外は各フック呼び出し単位でログに残して握りつぶし、1プラグインの不具合で他プラグイン・Ingestパイプライン全体を止めない設計。

**検証方法**: Docker Desktopを起動し、CI（`.github/workflows/backend-test.yml`）と同じ手順（`pytest` / `mypy .` / `ruff check .` / `pip-audit`）をpython:3.12-slimコンテナ+本物のpostgresコンテナで実行。pytest 28件全通過、mypy・ruffともにエラーなし（pip-auditはbaseイメージ同梱の`pip`自体の既知脆弱性のみを検出、本プロジェクトの依存関係には問題なし）。ブラウザでの実機確認は未実施（フロントエンドUIが伴わないため次回のPlugin設定UI実装時にまとめて行う）。

**次フェーズ（未着手）**: Plugin configuration UI（OQ-8方針: 単純項目フォーム＋複雑設定はJSONエディタ）、Quick setup wizard、Sensor/Alarm/Dashboard設定画面。

---

### 2026-10-02: Sprint 6後半（frontend） — Plugin設定UI・Quick Setup Wizard・設定画面

**背景**: 前述のPlugin System backend実装に続き、Sprint 6のfrontend部分を実装。ナビゲーションが今まで「ダッシュボード一覧⇔詳細」の2画面しかなかったため、`useUiStore`に`view: "main" | "settings" | "wizard"`を追加しグローバルナビゲーションを新設。

**実装内容**:
- `store/useUiStore.ts`: `view`状態とヘッダーnaviゲーション（`App.tsx`に`Nav`コンポーネント追加）
- `components/SettingsPage.tsx` + `components/settings/`: センサー・アラーム・プラグインの3タブ構成
  - `SensorSettingsPanel`: 一覧テーブル＋インライン編集（名前/単位/閾値）＋有効/無効トグル＋削除＋新規作成フォーム
  - `AlarmSettingsPanel`: 発生中/確認済み/解決済み/すべてでフィルタ、確認（ack）ボタン
  - `PluginSettingsPanel`: 有効/無効トグル、configのJSONエディタ（OQ-8方針通りJSONフォールバックのみ、スキーマ情報がないため個別フォームは未実装）
- `components/SetupWizard.tsx`: 4ステップのクイックセットアップ（センサー登録→テストデータ送信→ダッシュボード自動作成→完了）。`DashboardListPage`がダッシュボード0件のときバナーで誘導
  - ステップ2は実機curlコマンドを表示する方式を採用（INGEST_API_KEYはbackendの`.env`秘密情報のため、フロントエンドのバンドルに埋め込んで直接送信する設計は避けた。プレースホルダーで案内し、受信をポーリング検知して自動で次へ進む）
- `components/DashboardView.tsx`: ⚙設定ボタンから名前・説明を編集するモーダルを追加（Dashboard設定画面に相当）
- `lib/api.ts` / `types.ts` / `hooks/queries.ts`: `updateSensor`/`deleteSensor`/`fetchPlugins`/`enablePlugin`/`disablePlugin`/`updatePluginConfig`と`Plugin`型を追加

**検証方法**: `tsc --noEmit`・`eslint .`は両方エラーなし。さらにDocker Desktopで`docker compose up -d --build`し、実際にChromeでウィザードを最初から最後まで実行（センサー作成→curlでテストデータ送信→自動遷移→ダッシュボード自動作成→グラフ表示まで確認）。設定画面でセンサーの上限閾値を50に変更後、値55のテストデータを送ったところ実際にアラームが発生→確認（ack）まで動作。プラグインの有効化トグルも実際にbackendの`PATCH .../enable`を呼び出し、有効化後は`on_reading`フックでstatsがカウントアップすることをcurlで確認済み。

**ハマりどころ（今回の作業中に発覧、プラグインシステムとは無関係）**: ローカルのpostgresボリュームが`alembic_version`テーブルだけ残り実データテーブルが無い不整合な状態だった（過去のテストセッションの後始末漏れとみられる）。`DROP TABLE alembic_version`してから`alembic upgrade head`で復旧。今後同じ現象が出たら同じ手順で直せる。
