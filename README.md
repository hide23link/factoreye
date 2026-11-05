# FactorEye

FactorEye は、工場の設備の状態を見える化する OSS です。既存の PC と安価なセンサーだけで使えます。

センサー（ESP32 や Raspberry Pi など）から送られる値を受信し、蓄積し、ダッシュボードにグラフで表示します。しきい値を超えたら、Discord や Webhook で知らせます。

![ダッシュボード](docs/images/dashboard.png)

*画面はデモデータです*

## 簡単、でも自由に見える

- **すぐ見える**: センサー値を `POST /api/ingest/readings` で送るだけで、グラフになります。
- **自由に並べる**: グラフ・最新値・アラーム一覧・生産数を、ダッシュボードに好きに配置できます。
- **知らせる**: 上限・下限（軽故障・重故障）のしきい値で、Discord と Webhook（Zapier / Make / n8n など）に通知します。

## 使い方は簡単

Ubuntu・Debian・Raspberry Pi OS（64bit）で、次の 1 行を実行します。Docker が無ければ自動で入れます。

```bash
curl -fsSL https://raw.githubusercontent.com/hide23link/factoreye/main/install/install.sh | sudo bash
```

1. 表示された URL をブラウザで開く（管理パスワードは一度しか出ないので控える）
2. 画面右上の「セットアップガイド」に沿って、センサーを登録する
3. センサー側に [`clients/`](clients/) のライブラリかサンプルをコピーして、値を送る

Mac / Windows（Docker Desktop）や、設定・更新・削除の方法は [`install/README.md`](install/README.md) を参照してください。

> 配布版は http です。インターネットから使う場合は、Caddy や Cloudflare Tunnel などで https にしてください。

## ドキュメント

[仕様書](docs/architecture.md) ・ [機器キー](docs/device-keys.md) ・ [開発環境](docs/development.md) ・ [コントリビューション](CONTRIBUTING.md) ・ [セキュリティ](SECURITY.md)

## ライセンス

[MIT License](LICENSE)
