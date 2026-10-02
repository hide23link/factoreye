# 開発ノート

このファイルはAI(Claude Code)との開発セッションで決まった作業方針・変更履歴を記録する。
仕様そのものは `docs/factoreye-architecture.md` を参照。ここは運用メモ用。

---

## 作業時の方針

- **コマンドライン実行中のコメント（Bashツールの説明文）は日本語で、なるべくわかりやすく書く**
  （2026-10-01、社長からの指示）
- **`docker compose down -v` ・ `docker compose down --volumes` は、起動前に`docker compose ps`で
  「自分が今回起動したコンテナかどうか」を必ず確認してから実行する**（起動時点で既にRunning状態
  だったコンテナ・ボリュームは社長が使用中の可能性が高いため、`-v`を付けずに`down`する、または
  何もしない）。2026-10-02、E2Eテスト検証後の後片付けで、既に起動済みだったdev DBのボリューム
  （`factoreye_postgres-data`）を確認不足のまま`-v`付きで削除し、手動作成データを失わせる事故が
  発生したため（詳細は変更履歴参照）。

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

---

### 2026-10-02: 【事故】pytestが開発用DBの全テーブルをdropしていた問題と再発防止

**何が起きたか**: 上記「ハマりどころ」として何度も発生していた「`alembic_version`だけ残り実データテーブルが無い」現象の真因が判明。`backend/tests/conftest.py`の`_schema`フィクスチャ（session-scoped, autouse）はテストセッション終了時に`SQLModel.metadata.drop_all`で全テーブルを削除する。これ自体はテスト用DBに対しては正しい挙動だが、本セッション中は`docker run ... pytest ...`の`DATABASE_URL`を**開発者がdocker-composeで起動している本物のpostgresコンテナ（factoreye-postgres-1）** にそのまま向けてしまっていたため、pytest実行の度に**社長が実際にブラウザで作成していたセンサー・ダッシュボードのデータが丸ごと消えていた**。alembic_versionテーブルだけが生き残っていたのは、それがSQLModelのmetadata管理下になく`drop_all`の対象外だったため。

**影響**: 社長が手動で作成したセンサー・ダッシュボードのデータが複数回失われた（バックアップなし、復元不可）。実害があったことをお詫びし、ここに記録する。

**再発防止**:
- postgresコンテナ内に`factoreye_test`データベースを作成（`docker compose exec postgres psql -U factoreye -d factoreye -c "CREATE DATABASE factoreye_test OWNER factoreye;"`）
- 以後、backendのテストをdocker経由で実行する際は、必ず`DATABASE_URL`のDB名を`factoreye`ではなく`factoreye_test`に向けること
  ```
  -e DATABASE_URL=postgresql+asyncpg://factoreye:password@factoreye-postgres-1:5432/factoreye_test
  ```
- CI（GitHub Actions）は専用のpostgres serviceコンテナを都度起動しており本番/開発データと無関係なため、この問題は起きない（ローカルでdocker-composeの開発用DBに相乗りする時だけ要注意）。

---

### 2026-10-02: Sprint 7完了 — frontend単体テスト・E2Eテスト・README整備

**背景**: `docs/factoreye-architecture.md` のロードマップ通りSprint 7残課題（frontend単体テスト・E2E・README整備）に着手。backendのテストは既に完了済みだった。

**実装内容**:
- **frontend単体テスト**（Vitest + Testing Library、`frontend/`）: `vitest.config.ts`・`src/test/setup.ts`・`src/test/test-utils.tsx`（QueryClientProviderラッパー）を追加。`lib/time.ts`・`hooks/useNow.ts`・`store/useUiStore.ts`・`store/useHealthStore.ts`・`lib/api.ts`の単体テストと、`SensorSettingsPanel`・`AlarmSettingsPanel`のコンポーネントテスト（`../../lib/api`をvi.mockしてAPI呼び出しを検証）を追加。計24件、全通過。`npm run test`で実行、CIにも追加（`.github/workflows/frontend-build.yml`）
- **E2Eテスト**（Playwright、新規`e2e/`ディレクトリ、frontendとは別package.json）: docker-compose起動済みのスタック（backend:8000 / frontend:3001）に対し実ブラウザ（Chromium）で操作する2シナリオ
  - `setup-wizard.spec.ts`: Quick Setup Wizardをセンサー登録→（curlの代わりにPlaywrightの`request`でingest API直叩き）→ダッシュボード自動作成→Rechartsグラフ描画まで通しで確認
  - `alarm-flow.spec.ts`: 設定画面でセンサー閾値を編集→閾値超過データ送信→アラーム発生→確認(ack)まで確認
  - 新規CI `e2e-test.yml`: `docker compose up -d --build`→ヘルスチェック待ち→Playwright実行→失敗時はコンテナログを出力→`docker compose down -v`で後片付け
- **README.md**（リポジトリ直下、新規）: プロジェクト概要・クイックスタート（docker-compose）・開発環境セットアップ（backend/frontend個別）・テストの実行方法・ディレクトリ構成を整備

**検証方法**: frontend単体テストは`npm run test`（24件全通過）・`npm run typecheck`・`npm run lint`をエラーなしで確認。E2Eは実際にDocker Desktopで`docker compose up -d --build`してスタックを起動し、`npx playwright test`を実行、2シナリオとも実ブラウザで通過を確認（並列実行でも安定）。

**ハマりどころ**: `alarm-flow.spec.ts`で、編集モード中のセンサー行をセンサー名（`hasText: sensorName`）で再取得しようとして失敗した。編集モードでは名前欄が`<input>`に置き換わり、Playwrightの`hasText`はinputのvalueを要素のテキストとして見てくれないため。常にプレーンテキストの`<td>`のまま残るingestKey列で行を特定するよう修正して解決。

**【事故】検証後の`docker compose down -v`でdev DBのデータを削除**: E2Eテスト検証のため`docker compose up -d --build`を実行した際、`factoreye-postgres-1`・`factoreye-backend-1`は起動前から既にRunning状態だった（社長が使用中だった可能性が高い）。検証後の後片付けで`docker compose down -v`を実行し、既存データが入っていた可能性のあるボリューム`factoreye_postgres-data`を確認なしに削除してしまった。バックアップなし・復元不可。社長に確認の上、空のDBのまま続行することで合意（2026-10-02）。再発防止策は上記「作業時の方針」に追記済み（`-v`付きdown前に`docker compose ps`で起動前の状態を確認する）。

**次フェーズ**: Sprint 8（Polish & Release）。

---

### 2026-10-02: qa-agentレビューで発覚したCritical/High修正（Sprint 7の続き）

**背景**: 上記Sprint 7実装をqa-agent（独立したレビューセッション）がレビュー。実際に`docker compose up -d --build`をフレッシュな状態（直前の事故でボリュームが空になった状態）で実行して再現性のあるCriticalバグを発見した。

**Critical: backend起動時にDBマイグレーションが自動実行されず、フレッシュなDBではクラッシュする**
- 症状: `UndefinedTableError: relation "plugins" does not exist`でbackendがクラッシュループする
- 原因: `backend/Dockerfile`のCMDが`uvicorn app.main:app ...`のみで、どこにも`alembic upgrade head`を実行する手順が無かった（既存のdocker-composeボリュームには過去の手動マイグレーション適用結果が残っていたため、今回のボリューム消失事故が起きるまで誰も気づいていなかった）
- 影響: 新設した`e2e-test.yml`はGitHub Actionsの完全フレッシュなrunnerで動くため、このコミットのままでは初回実行から確実に失敗する状態だった
- **修正**: `backend/Dockerfile`のCMDを`sh -c "alembic upgrade head && uvicorn app.main:app --host 0.0.0.0 --port 8000"`に変更。postgresの`depends_on: condition: service_healthy`で起動順序は保証済みのため追加のリトライ処理は不要
- 検証: qa-agent側で`docker compose run --rm backend alembic upgrade head`を手動実行して原因を確定済み。dev側では今回Docker操作がauto modeの権限クラシファイアに（直前の事故を踏まえて）ブロックされローカルでの再検証ができなかったため、修正をpushして**GitHub Actions上のフレッシュなrunnerで直接検証**する方針に切り替えた。結果は下記参照。

**High: `alarm-flow.spec.ts`のack検証アサーションが無意味だった**
- 原因: `page.getByRole("button", { name: "確認済み" })`が、ackボタンのクリックとは無関係に常時表示されているステータスフィルタタブ（同じ文言）にヒットしてしまい、ackが実際に成功したかを何も検証できていなかった（テスト自体はたまたま毎回パスしていた）
- **修正**: ack後に「発生中」一覧からその行が消えること（`toHaveCount(0)`）を見てから「確認済み」タブに切り替え、そちらに移動していることを確認する形に変更

**Low（対応済み）**: `e2e-test.yml`に`paths`フィルタを追加（`frontend-build.yml`と同様、backend/frontend/e2e/docker-compose.yml以外の変更では起動しないように）。

**Low（Sprint 8バックログへ）**: qa-agentより以下を指摘、coordinator-agentへのバックログ化を推奨
- frontendのカバレッジ計測ツール（`@vitest/coverage-v8`等）未導入。数値目標（guidelines/12: 70%以上/最低50%）を検証する手段が無い
- `SetupWizard.tsx`・`WidgetFormModal.tsx`・`DashboardView.tsx`・4つのwidgetコンポーネント・`lib/api.ts`の大半の関数が単体/コンポーネントテスト0件のまま（E2Eのハッピーパスでのみ間接的にカバー）
- 自宅LXC self-hosted runner移行時、`docker compose down -v`がrunner間で永続化されたdockerホスト上で動くと、project名の衝突により今回と同種のボリューム削除事故がCI経由でも起こりうる。移行時に専用project名（`docker compose -p factoreye-ci ...`等）を使うことをinfra-agentへ要申し送り

**GitHub Actionsのフレッシュなrunnerで実際に検証した結果、上記のCritical修正だけでは不十分で、さらに2件見つかった（ローカルの使い回しdev DBでは絶対に踏まない、フレッシュ環境特有のバグ）**:

1. **`e2e-test.yml`の「Wait for backend/frontend」が実質リトライしていなかった**: `curl --retry-connrefused`は"connection refused"のみ再試行対象で、コンテナのポートは開いているがアプリがまだlistenしていない瞬間に起きる「Recv failure: Connection reset by peer」は対象外。そのためpostgresが起動し終えた直後、backend/frontendがまだ起動準備中の1回目の呼び出しで即座に失敗していた（`docker compose logs`にbackend-1の出力が1行も無い段階で落ちていたことから確定）。`curl --retry`任せをやめ、個々のcurl失敗を無視して`sleep 3`を挟みながら最大40回ポーリングする素朴なループに変更して解決。
2. **`setup-wizard.spec.ts`がダッシュボード0件時にボタン名の部分一致で2件ヒットしていた**: `DashboardListPage`はダッシュボードが1件も無いと「セットアップガイドを始める」というCTAボタンを表示する。ヘッダーnavの「セットアップガイド」ボタンをPlaywrightのデフォルト（部分一致）の`getByRole`で探すと、このCTAボタンにも同時にヒットしてstrict mode violationになる。ローカル検証時はdev DBに既存ダッシュボードがあったため0件状態に一度も遭遇せず見逃していた。`page.locator("nav").getByRole(...)`でヘッダーnav内に絞って解決。

**教訓**: 今回のSprint 7実装・レビュー・CI検証を通じて、「ローカルの使い回しdev DB」と「フレッシュな環境（CI・新規セットアップするユーザー）」で挙動が変わる箇所が3つ（マイグレーション未適用・ヘルスチェックの競合状態・ダッシュボード0件時のUI分岐）も見つかった。E2E/統合テストは可能な限りフレッシュな状態（ボリューム未作成）で一度は通しておくべき、というのが今回最大の学び。最終的に`e2e-test.yml`はGitHub Actions上のフレッシュなrunnerで3シナリオ連続グリーンを確認済み（commit `67ff51b`）。

---

### 2026-10-02: 生産数指標の拡充（分あたり→時間/日/目標達成率）

**背景**: 社長から「生産数が分あたりではなく、時間あたりとか、日にちあたりとか、その日の予定数とか、もっと製造現場で必要な一般的な生産数に拡充してほしい」との要望。strategy-agentが市場調査（中小製造業の生産性指標・OEE等）を行い、Phase 0の非目標（複雑な生産管理システム化はしない）と整合する範囲として「時間あたり生産数・日次累計・日次目標達成率」をA案として採用（OEEは停止理由記録・シフトカレンダー等の新規データモデルが要るため見送り、将来追加を妨げない設計であることは確認済み）。

**実装内容**:
- **backend集計API新設**: `GET /api/sensors/{id}/readings/aggregate?from=<ISO>&to=<ISO任意>` を追加（`app/api/sensors.py`・`app/schemas.py`の`ReadingAggregate`）。SQLの`SUM`+`COUNT(1)`で集計し、生データ全件をフロントに返さない設計。pytestを6件追加（正常系・範囲外・空データ・センサー不在・from必須）、既存分と合わせて52件全通過、mypy/ruff/pip-auditも確認
- **WidgetConfigにdailyTarget追加**: `frontend/src/types.ts`に`dailyTarget?: number`を追加。`WidgetFormModal.tsx`のProductionStatusタイプに「稼働中とみなす閾値」「本日の生産目標数」の入力欄を新設（`onThreshold`は既にconfig型にはあったが入力UIが無く設定不可能だった抜け漏れも合わせて解消）
- **ProductionStatusWidget拡張**: 「稼働中/停止中」表示に加え、「直近1時間」「本日累計」の集計値と、`dailyTarget`設定時のみ「目標達成率」を表示
- **emulator変更**: 「生産数」センサーの送信値を、瞬間的な0〜100の抽象指標から「直近5秒間で実際に生産した個数」という実カウント値（整数、単位「個」）に変更。内部の生産負荷指標（0〜100、温度・電力の計算にのみ使用）から導出し、通常運転中は生産数が0個に張り付かない（＝稼働中判定がチラつかない）よう平均値とノイズ幅を調整済み（`tools/factory-emulator/README.md`にも反映。旧バージョンで単位「個/分」のまま登録済みのセンサーは自動更新されないため、手動変更が必要な旨を明記）

**検証方法**: backend（pytest 52件・mypy・ruff・pip-audit）、frontend（Vitest 30件・tsc --noEmit・ESLint）を全てエラーなしで確認。さらに実際にdocker-compose環境（Docker Desktop、フレッシュ寄りの状態）でbackend/frontendを再ビルド・起動し、emulatorを新コードで再起動してcurlで実データ（整数カウント値）を確認、`/readings/aggregate`エンドポイントを実際に叩いて集計結果を確認。E2E（Playwright、2シナリオ）も実行し、全通過を確認（下記「ハマりどころ」参照）。

**ハマりどころ**:
- `func.count(Reading.id)`はSQLModelのクラス属性がmypyには素のPython型（`int | None`）に見えてしまい弾かれる（このファイルで既出の別の箇所と同種の誤検知）。`func.count(1)`（`COUNT(1)`、行数を数えるだけなのでカラム指定は不要）に変更して解決
- `session.execute()`で素朴に書いたところ、SQLModelから「`session.exec()`を使うべき」というDeprecationWarningが出た。多カラムselect（`func.sum`+`func.count`のタプル）でも`session.exec()`が問題なく`Row`タプルを返すことを確認し、そちらに統一
- E2E実行時、直前のLANアクセス設定用`.env`（`VITE_API_URL=http://192.168.0.25:8000`等）が残ったままだったため、Playwrightが`localhost:3001`で開いたページのOriginとbackendのCORS許可Origin（`192.168.0.25:3001`）が食い違い、全シナリオが「backend未接続」「Failed to fetch」で失敗した。自分の実装のリグレッションではなく環境設定の残留が原因と確認（`.env`を一時的に外して再ビルド→E2E全通過を確認→LAN設定を復元して再ビルドし直した）。**教訓**: 同じdocker-composeスタックを「社長が他のPCから見る用」と「E2E検証用」で同時に使い回すと、ベースURL前提（localhost vs LAN IP）の食い違いで混乱しやすい。本来は分離すべきだが、Phase 0のソロ運用では都度一時的に戻す運用で許容する

**次フェーズ**: OEEに着手する場合は、停止時間＋理由の記録（新規DowntimeEventテーブル相当）とシフトカレンダー（負荷時間の定義）が新規で必要（strategy-agentの分析参照）。

---

### 2026-10-02: センサー削除をsoft-delete→物理削除に変更

**背景**: デモ環境でエミュレータのセンサーを削除→同じ名前で再登録しようとしたところ失敗（409）。原因はsoft-delete方式の既知の制限（`db/models.py`に以前から「name/ingest_keyのunique制約はdeleted_at済み行にも及ぶ」とコメントされていた）。社長に方針を確認し、「アラーム履歴が削除時に一緒に消えるリスクを許容してでも完全削除にする」で合意（AskUserQuestionで3択提示し選択いただいた）。

**実装内容**:
- `Sensor.deleted_at`フィールドを削除。`DELETE /api/sensors/:id`を物理削除（`session.delete(sensor)`）に変更
- `Reading.sensor_id`・`Alarm.sensor_id`のFKに`ondelete="CASCADE"`、`Widget.sensor_id`に`ondelete="SET NULL"`を設定（マイグレーション`532b37a49a1d`で制約を貼り替え）。ウィジェット自体は消さず、センサーとの紐付けだけ外れる
- `list_sensors`・`_get_active_sensor`・ingest時のセンサー検索から`deleted_at`フィルタを除去
- frontendの削除確認ダイアログを「履歴データは保持されます」→「測定値・アラーム履歴も完全に削除されます。元に戻せません」に修正（実態と合わせる）
- backendテスト3件追加（名前再利用が成功すること・Reading/AlarmがCASCADE削除されること・Widgetの紐付けだけNULL化されウィジェット自体は残ること）。55件全通過、mypy/ruff/pip-audit確認済み

**ハマりどころ**: FKに`ondelete="CASCADE"`を設定しただけでは不十分だった。`session.delete(sensor)`経由の削除では、SQLAlchemy ORMが既定で関連オブジェクト（readings/alarms/widgets）を先にロードしてFKをNULL化しようとする（DBのON DELETE設定より先にORM側の既定動作が効いてしまう）ため、非NULL許容のはずの`Alarm.sensor_id`が黙ってNULLに書き換えられ、テストで発覚した。`Sensor`側の3つの`Relationship`に`sa_relationship_kwargs={"passive_deletes": True}`を追加し、ORMに子をロードさせずDBのCASCADE/SET NULLに任せることで解決。

**意図的に対象外**: Dashboardの`deleted_at`（soft-delete）はそのまま。今回の問題はSensorのunique制約（name/ingestKey）特有のものでDashboardには無く、変更依頼も無かったため触っていない。

**次フェーズ**: 変更をpush後、GitHub Actions（backend-test / frontend-build / e2e-test）が全てグリーンになることを確認する。
