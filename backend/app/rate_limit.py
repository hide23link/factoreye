"""レート制限（slowapi、インメモリストア。単一LXCインスタンス前提でRedis不要）。"""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
