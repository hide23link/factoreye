"""レート制限（slowapi、インメモリストア。単一インスタンス前提のため Redis は不要）。

制限は「利用者（接続元）ごと」に数える。制限を超えると 429 を返す。
取り込み API（api/ingest.py）と、認証 API（api/auth.py・管理者ログイン）に付けている。
"""
from fastapi import Request
from slowapi import Limiter
from slowapi.util import get_remote_address


def client_ip(request: Request) -> str:
    """制限の鍵にする接続元 IP。

    本番は Cloudflare Tunnel → Caddy → backend の経路で、backend から見た接続元は
    常に Caddy のコンテナ IP になる。そのままだと全利用者が 1 つの枠を共有してしまうため、
    Cloudflare が付ける CF-Connecting-IP（実際の接続元）を使う。
    このヘッダーを信頼してよいのは、Caddy を 127.0.0.1 だけで待ち受けさせ、
    外部から直接届かない構成（docker-compose.cloud.yml）のときだけ。
    """
    forwarded = request.headers.get("cf-connecting-ip", "").strip()
    return forwarded or get_remote_address(request)


# アプリ全体で1つの制限器。カウントはこのプロセスのメモリにあるので、
# 複数のプロセスに分けて動かすと、制限は別々に数えられる（単一インスタンス前提）
limiter = Limiter(key_func=client_ip)
