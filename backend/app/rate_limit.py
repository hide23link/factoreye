"""レート制限（slowapi、インメモリストア。単一インスタンス前提のため Redis は不要）。"""
from slowapi import Limiter
from slowapi.util import get_remote_address

limiter = Limiter(key_func=get_remote_address)
