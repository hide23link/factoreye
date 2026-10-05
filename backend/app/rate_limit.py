"""レート制限（slowapi、インメモリストア。単一インスタンス前提のため Redis は不要）。

制限は「接続元 IP ごと」に数える（get_remote_address）。制限を超えると 429 を返す。
取り込み API（api/ingest.py）にだけ付けている。
"""
from slowapi import Limiter
from slowapi.util import get_remote_address

# アプリ全体で1つの制限器。カウントはこのプロセスのメモリにあるので、
# 複数のプロセスに分けて動かすと、制限は別々に数えられる（単一インスタンス前提）
limiter = Limiter(key_func=get_remote_address)
