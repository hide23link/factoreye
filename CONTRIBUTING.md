# コントリビューションガイド

FactorEye への貢献に興味を持っていただきありがとうございます。バグ報告・機能提案・ドキュメント修正・コードのPRなど、どの形の貢献も歓迎します。

貢献する際は [行動規範（CODE_OF_CONDUCT.md）](CODE_OF_CONDUCT.md) に同意したものとみなします。

---

## 貢献の流れ

1. **Issue を確認する**: 既存の Issue と重複していないか確認してください。大きめの変更（新機能・設計変更）は、実装前に Issue を立てて方向性を相談することを推奨します。[`good first issue`](https://github.com/hide23link/factoreye/labels/good%20first%20issue) ラベルは初めての貢献におすすめです。
2. **Fork してブランチを作る**:
   ```bash
   git checkout main && git pull origin main
   git checkout -b feature/your-change   # fix/, docs/, refactor/ も使えます
   ```
3. **実装する**: [`docs/architecture.md`](docs/architecture.md)（仕様）と [`docs/decisions.md`](docs/decisions.md)（設計判断の経緯）を確認してください。既存の判断と食い違う変更をする場合は、理由を PR に書いてください。
4. **テストを通す**（[README](README.md#開発環境) の手順と同じ）:
   ```bash
   # backend
   cd backend && pytest && mypy app && ruff check app tests && pip-audit

   # frontend
   cd frontend && npm run test && npm run typecheck && npm run lint
   ```
5. **コミットする**（[Conventional Commits](https://www.conventionalcommits.org/)）:
   ```
   feat(ingest): add API key authentication
   fix(db): resolve N+1 query in sensor list
   docs(readme): add quickstart guide
   ```
   `feat` / `fix` / `docs` / `refactor` / `test` / `chore` / `perf` / `ci` のいずれかを使ってください。DCO（`git commit -s`）での署名を推奨します。
6. **PR を作る**: テンプレートの項目（変更内容・理由・テスト方法・チェックリスト）を埋めてください。関連 Issue があれば `Closes #123` を本文に書いてください。

## コーディング規約

- **Backend**: Python 3.12+ / FastAPI / SQLModel。型ヒント必須、`mypy --strict` を通す（`Any` は使わない）。関数は単一責任で 20 行を超えたら分割を検討する。
- **Frontend**: TypeScript（`strict: true`）/ React 18。`any` は使わない（`unknown` を使う）。
- **命名**: backend は `snake_case`（ファイル）/ `PascalCase`（クラス）、frontend は `kebab-case`（ファイル）/ `PascalCase`（コンポーネント）。
- **コメント**: 「何を」ではなくコードから読み取れない「なぜ」を書く。
- DB スキーマの変更は Alembic マイグレーションで行い、破壊的変更は [`CHANGELOG.md`](CHANGELOG.md) の「Removed」に明記する。

## 依存関係の追加

新しいライブラリを追加する場合、ライセンスが MIT / Apache 2.0 / BSD など再配布に問題ない種類か確認してください（GPL 系は不可）。PR の説明にライブラリ名とライセンスを記載してください。

## バージョニング

[Semantic Versioning](https://semver.org/)（`MAJOR.MINOR.PATCH`）に従います。PATCH はバグ修正、MINOR は後方互換のある機能追加、MAJOR は破壊的変更です。

## 質問・相談

バグ報告・機能提案は Issue、使い方の質問や雑談は [Discussions](https://github.com/hide23link/factoreye/discussions) を使ってください。
