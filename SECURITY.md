# セキュリティポリシー

## 対象

`main` の最新版のみをサポートします。

## 脆弱性の報告

**公開の Issue ではなく**、GitHub の [Private Vulnerability Reporting](https://github.com/hide23link/factoreye/security/advisories/new)（Security タブ → 「Report a vulnerability」）から報告してください。

次を含めてください: 想定される影響、再現手順、対象バージョン。修正後に、GitHub Security Advisories で公開します（希望があれば報告者名も記載します）。

## 報告の前に（想定された動作）

- **self-hosted の REST API は、取り込み（Ingest）以外に認証がありません。** 社内 LAN や VPN の中で使う前提です。インターネットへ直接公開しないでください
- **Webhook の送信先は SSRF 対策済み**です（`https` で、公開 IP のみ）。`WEBHOOK_ALLOW_PRIVATE_NETWORKS=true` のときだけ社内向けを許可します
- **管理者アカウント**（SaaS 版の `/admin`）は DB ではなくサーバー上のファイルで管理します

詳細は [`docs/architecture.md`](docs/architecture.md) を参照してください。これら以外の認証回避・他ワークスペースのデータの閲覧・インジェクションなどは、脆弱性として報告してください。
