# コントリビューションガイド

バグ報告・機能提案・ドキュメント修正・PR を歓迎します。

## 流れ

1. 既存の [Issue](https://github.com/hide23link/factoreye/issues) を確認する。大きな変更（新機能・設計変更）は、実装前に Issue で相談してください
2. Fork して、`main` からブランチを作る（`feature/` `fix/` `docs/` など）
3. 実装する。仕様は [`docs/architecture.md`](docs/architecture.md)。食い違う変更は、理由を PR に書いてください
4. テストを通す（手順は [`docs/development.md`](docs/development.md)）
5. PR を作る。テンプレートを埋め、関連 Issue があれば `Closes #123` と書いてください

コミットメッセージは [Conventional Commits](https://www.conventionalcommits.org/)（`feat` / `fix` / `docs` / `refactor` / `test` / `chore`）に沿ってください。

## 守ること

- Backend は型ヒント必須で `mypy --strict` を通す。Frontend は `strict: true` で `any` を使わない
- コメントには、コードから読み取れない「なぜ」を書く
- DB スキーマの変更は Alembic マイグレーションで行い、破壊的変更は PR に明記する
- 依存ライブラリは、再配布できるライセンス（MIT / Apache 2.0 / BSD など。GPL 系は不可）のものだけ。PR にライブラリ名とライセンスを書く

バージョンは [Semantic Versioning](https://semver.org/) に従います。

## 質問

バグ・提案は Issue、使い方の質問は [Discussions](https://github.com/hide23link/factoreye/discussions) へ。
