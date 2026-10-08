"""バックアップの読み込み元（ディレクトリ・S3）と、ファイルの検証。

読み込み元は読むだけで、ファイルを消したり書き換えたりしない（控えを守るため）。
"""

from __future__ import annotations

import gzip
import hashlib
import re
import zlib
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import TYPE_CHECKING, Protocol

from botocore.exceptions import ClientError

if TYPE_CHECKING:
    from mypy_boto3_s3 import S3Client

# infra/backup.sh の出力（factoreye-<日時>.sql.gz）と、手で取ったもの（backup-before-*.sql.gz）の
# 両方を扱う。URL のパスにそのまま入るため、ディレクトリをまたぐ名前（../ など）は通さない
BACKUP_NAME_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*\.sql\.gz$")
CHECKSUM_SUFFIX = ".sha256"
_CHUNK = 1024 * 1024


class SourceError(Exception):
    pass


@dataclass(frozen=True)
class BackupEntry:
    name: str
    size: int
    modified: datetime


@dataclass(frozen=True)
class FetchedBackup:
    path: Path
    # 隣の .sha256 に書かれた値。無ければ None（infra/backup.sh の古い版で取ったもの）
    expected_sha256: str | None
    # 使い終わったら消すもの（S3 から取ってきた一時的な控え。ディスクを埋めないように）
    temporary: bool = False


@dataclass(frozen=True)
class VerifyResult:
    sha256: str
    # "ok" / "mismatch" / "missing"（.sha256 が無い）
    checksum: str
    gzip_ok: bool
    error: str | None

    @property
    def ok(self) -> bool:
        return self.gzip_ok and self.checksum != "mismatch"


class BackupSource(Protocol):
    def describe(self) -> str: ...

    def list(self) -> list[BackupEntry]: ...

    def fetch(self, name: str) -> FetchedBackup: ...


def validate_name(name: str) -> str:
    if not BACKUP_NAME_RE.fullmatch(name):
        raise SourceError(f"バックアップの名前が不正です: {name}")
    return name


def parse_checksum(text: str) -> str | None:
    """sha256sum の出力（"<hex>  <ファイル名>"）から値を取り出す。"""
    first = text.strip().split(maxsplit=1)
    if first and re.fullmatch(r"[0-9a-fA-F]{64}", first[0]):
        return first[0].lower()
    return None


class LocalSource:
    def __init__(self, directory: Path) -> None:
        self._dir = directory

    def describe(self) -> str:
        return str(self._dir)

    def exists(self) -> bool:
        return self._dir.is_dir()

    def list(self) -> list[BackupEntry]:
        if not self._dir.is_dir():
            raise SourceError(f"バックアップのディレクトリがありません: {self._dir}")
        entries = []
        for p in self._dir.iterdir():
            if p.is_file() and BACKUP_NAME_RE.fullmatch(p.name):
                st = p.stat()
                entries.append(
                    BackupEntry(p.name, st.st_size, datetime.fromtimestamp(st.st_mtime, UTC))
                )
        return sorted(entries, key=lambda e: e.modified, reverse=True)

    def fetch(self, name: str) -> FetchedBackup:
        path = self._dir / validate_name(name)
        if not path.is_file():
            raise SourceError(f"バックアップが見つかりません: {name}")
        sidecar = path.with_name(path.name + CHECKSUM_SUFFIX)
        expected = parse_checksum(sidecar.read_text()) if sidecar.is_file() else None
        return FetchedBackup(path, expected)


class S3Source:
    def __init__(self, client: S3Client, bucket: str, prefix: str, cache_dir: Path) -> None:
        self._client = client
        self._bucket = bucket
        self._prefix = prefix.strip("/")
        self._cache = cache_dir

    def describe(self) -> str:
        return f"s3://{self._bucket}/{self._prefix}"

    def _key(self, name: str) -> str:
        return f"{self._prefix}/{name}" if self._prefix else name

    def list(self) -> list[BackupEntry]:
        entries = []
        paginator = self._client.get_paginator("list_objects_v2")
        prefix = f"{self._prefix}/" if self._prefix else ""
        for page in paginator.paginate(Bucket=self._bucket, Prefix=prefix):
            for obj in page.get("Contents", []):
                name = obj["Key"].rsplit("/", 1)[-1]
                if BACKUP_NAME_RE.fullmatch(name):
                    entries.append(BackupEntry(name, obj["Size"], obj["LastModified"]))
        return sorted(entries, key=lambda e: e.modified, reverse=True)

    def fetch(self, name: str) -> FetchedBackup:
        validate_name(name)
        self._cache.mkdir(parents=True, exist_ok=True)
        dest = self._cache / name
        try:
            self._client.download_file(self._bucket, self._key(name), str(dest))
        except Exception as e:  # boto3 は失敗の種類ごとに別の例外を投げるため、まとめて伝える
            raise SourceError(f"S3 から取得できませんでした: {name}: {e}") from e
        try:
            body = self._client.get_object(
                Bucket=self._bucket, Key=self._key(name + CHECKSUM_SUFFIX)
            )["Body"].read()
            expected = parse_checksum(body.decode("utf-8", errors="replace"))
        except ClientError:
            # 無い場合、読むだけの鍵では NoSuchKey ではなく AccessDenied が返る。
            # どちらも「記録なし」として扱う
            expected = None
        return FetchedBackup(dest, expected, temporary=True)


class CompositeSource:
    """複数の読み込み元を 1 つに見せる（本来のバックアップ ＋ 書き戻しの直前の控え）。"""

    def __init__(self, sources: list[BackupSource]) -> None:
        self._sources = sources

    def describe(self) -> str:
        return " ＋ ".join(s.describe() for s in self._sources)

    def list(self) -> list[BackupEntry]:
        entries: list[BackupEntry] = []
        for s in self._sources:
            if isinstance(s, LocalSource) and not s.exists():
                continue  # 控えのディレクトリは、最初の書き戻しまで無い
            entries.extend(s.list())
        return sorted(entries, key=lambda e: e.modified, reverse=True)

    def fetch(self, name: str) -> FetchedBackup:
        errors = []
        for s in self._sources:
            try:
                return s.fetch(name)
            except SourceError as e:
                errors.append(str(e))
        raise SourceError(errors[-1] if errors else f"バックアップが見つかりません: {name}")


def make_source(spec: str, cache_dir: Path, s3_endpoint_url: str | None = None) -> BackupSource:
    if spec.startswith("s3://"):
        import boto3  # S3 を使わない場所（ラズパイの手元のディレクトリなど）では読み込まない

        bucket, _, prefix = spec.removeprefix("s3://").partition("/")
        if not bucket:
            raise SourceError(f"S3 のバケット名がありません: {spec}")
        client = boto3.client("s3", endpoint_url=s3_endpoint_url)
        return S3Source(client, bucket, prefix, cache_dir)
    return LocalSource(Path(spec))


def verify(fetched: FetchedBackup) -> VerifyResult:
    """sha256 と gzip の両方を一度の読み込みで確かめる。

    gzip を最後まで展開するのは、末尾が欠けたファイル（停電中の書き込みなど）を見つけるため。
    """
    digest = hashlib.sha256()
    decomp = zlib.decompressobj(wbits=31)
    gzip_ok, error = True, None
    with fetched.path.open("rb") as f:
        while chunk := f.read(_CHUNK):
            digest.update(chunk)
            if gzip_ok:
                try:
                    decomp.decompress(chunk)
                except zlib.error as e:
                    gzip_ok, error = False, f"gzip の展開に失敗: {e}"
    if gzip_ok and not decomp.eof:
        gzip_ok, error = False, "gzip が途中で切れています"

    actual = digest.hexdigest()
    if fetched.expected_sha256 is None:
        checksum = "missing"
    elif fetched.expected_sha256 == actual:
        checksum = "ok"
    else:
        checksum = "mismatch"
        error = error or "sha256 が記録と一致しません（破損か改ざん）"
    return VerifyResult(actual, checksum, gzip_ok, error)


def open_sql(path: Path) -> gzip.GzipFile:
    return gzip.open(path, "rb")
