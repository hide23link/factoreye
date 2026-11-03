# サードパーティのソフトウェア

FactorEye 本体は [MIT License](LICENSE) です。次のソフトウェアを利用しており、それぞれのライセンスに従います。
ここに挙げるのは、直接使っているものです。その先の依存（推移的な依存）も、2026-11-03 の時点で、すべて許可的なライセンス（MIT・ISC・BSD・Apache-2.0・PSF など）であることを確認しました（`certifi` は MPL-2.0。次の「注意」を参照）。

## 画面（frontend）

| パッケージ | 版 | ライセンス |
|---|---|---|
| @tanstack/react-query | 5.104.0 | MIT |
| react | 18.3.1 | MIT |
| react-dom | 18.3.1 | MIT |
| react-grid-layout | 2.2.4 | MIT |
| recharts | 3.10.1 | MIT |
| zustand | 5.0.15 | MIT |

## バックエンド（backend）

| パッケージ | 版 | ライセンス |
|---|---|---|
| fastapi | 0.162.0 | MIT |
| uvicorn | 0.54.0 | BSD-3-Clause |
| uvloop | 0.23.0 | Apache-2.0 / MIT |
| httptools | 0.9.0 | MIT |
| sqlmodel | 0.0.48 | MIT |
| SQLAlchemy | 2.1.6 | MIT |
| asyncpg | 0.32.0 | Apache-2.0 |
| **psycopg** | 3.3.7 | **LGPL-3.0** |
| alembic | 1.20.1 | MIT |
| pydantic | 2.14.2 | MIT |
| pydantic-settings | 2.16.2 | MIT |
| slowapi | 0.1.10 | MIT |
| httpx | 0.28.1 | BSD-3-Clause |
| PyJWT | 2.15.1 | MIT |
| bcrypt | 5.0.0 | Apache-2.0 |

版は、公開時にビルドしたイメージに入っていた版です（`requirements.txt` は下限だけを指定しているため、ビルドのたびに最新の版が入ります）。

## 配布イメージに含まれるもの

| ソフトウェア | ライセンス |
|---|---|
| PostgreSQL 15（`postgres:15`） | PostgreSQL License |
| nginx（`nginx:alpine`） | BSD-2-Clause |
| Python 3.12 | PSF License |
| WAL-G（クラウド版の DR 用 PostgreSQL イメージだけ） | Apache-2.0 |

## 注意

- **psycopg（LGPL-3.0）**: ライブラリとして、変更せずに、そのまま利用しています（`pip install` で入る形のまま、Python の `import` で呼ぶだけ）。LGPL では、利用者が自分で psycopg を入れ替えられる状態を保つ必要があります。このプロジェクトは、psycopg を同梱・改変せず、`requirements.txt` で入れるだけなので、この条件を満たします。ソースは https://github.com/psycopg/psycopg です。
- **certifi（MPL-2.0）**: 推移的な依存です。改変せず、そのまま利用しています。
- 各パッケージのライセンス全文は、イメージの中の各パッケージのディレクトリ（`site-packages/*.dist-info/`、`node_modules/*/LICENSE`）にあります。
