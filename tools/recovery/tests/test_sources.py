import gzip
import hashlib
import io
import os
from datetime import UTC, datetime
from pathlib import Path

import pytest
from botocore.exceptions import ClientError

from recovery.sources import (
    FetchedBackup,
    LocalSource,
    S3Source,
    SourceError,
    make_source,
    parse_checksum,
    validate_name,
    verify,
)
from tests.conftest import write_dump


def _sidecar(path: Path, digest: str | None = None) -> None:
    digest = digest or hashlib.sha256(path.read_bytes()).hexdigest()
    path.with_name(path.name + ".sha256").write_text(f"{digest}  {path.name}\n")


@pytest.mark.parametrize(
    "name",
    ["factoreye-20261008-030001.sql.gz", "backup-before-lt-cleanup-20261005-2311.sql.gz"],
)
def test_validate_name_accepts_backup_names(name: str) -> None:
    assert validate_name(name) == name


@pytest.mark.parametrize(
    "name", ["../etc/passwd.sql.gz", "a/b.sql.gz", ".hidden.sql.gz", "x.sql", "x.tar.gz.enc", ""]
)
def test_validate_name_rejects_paths_and_other_files(name: str) -> None:
    with pytest.raises(SourceError):
        validate_name(name)


def test_parse_checksum() -> None:
    digest = "a" * 64
    assert parse_checksum(f"{digest}  factoreye-1.sql.gz\n") == digest
    assert parse_checksum(f"{digest.upper()} x") == digest
    assert parse_checksum("not-a-checksum") is None
    assert parse_checksum("") is None


def test_local_list_only_backups_newest_first(tmp_path: Path) -> None:
    old = write_dump(tmp_path, "factoreye-20261001-030000.sql.gz")
    new = write_dump(tmp_path, "factoreye-20261002-030000.sql.gz")
    os.utime(old, (1_000_000, 1_000_000))
    _sidecar(new)
    (tmp_path / "factoreye-20261002-030000-config.tar.gz.enc").write_bytes(b"x")
    (tmp_path / "backup.log").write_text("log")

    names = [e.name for e in LocalSource(tmp_path).list()]

    assert names == [new.name, old.name]


def test_local_list_missing_directory(tmp_path: Path) -> None:
    with pytest.raises(SourceError):
        LocalSource(tmp_path / "nope").list()


def test_local_fetch_reads_sidecar(tmp_path: Path) -> None:
    path = write_dump(tmp_path, "factoreye-1.sql.gz")
    _sidecar(path)

    fetched = LocalSource(tmp_path).fetch(path.name)

    assert fetched.path == path
    assert fetched.expected_sha256 == hashlib.sha256(path.read_bytes()).hexdigest()


def test_local_fetch_rejects_traversal(tmp_path: Path) -> None:
    with pytest.raises(SourceError):
        LocalSource(tmp_path).fetch("../x.sql.gz")


def test_verify_ok(tmp_path: Path) -> None:
    path = write_dump(tmp_path, "factoreye-1.sql.gz")
    _sidecar(path)

    result = verify(LocalSource(tmp_path).fetch(path.name))

    assert (result.checksum, result.gzip_ok, result.ok) == ("ok", True, True)


def test_verify_without_sidecar_is_still_ok(tmp_path: Path) -> None:
    path = write_dump(tmp_path, "factoreye-1.sql.gz")

    result = verify(FetchedBackup(path, None))

    assert (result.checksum, result.ok) == ("missing", True)


def test_verify_detects_checksum_mismatch(tmp_path: Path) -> None:
    path = write_dump(tmp_path, "factoreye-1.sql.gz")

    result = verify(FetchedBackup(path, "0" * 64))

    assert (result.checksum, result.gzip_ok, result.ok) == ("mismatch", True, False)


def test_verify_detects_truncated_gzip(tmp_path: Path) -> None:
    # 停電などで書き込みが途中で止まったファイル
    path = tmp_path / "factoreye-1.sql.gz"
    path.write_bytes(gzip.compress(b"SELECT 1;\n" * 10_000)[:-20])

    result = verify(FetchedBackup(path, None))

    assert not result.gzip_ok
    assert not result.ok


def test_verify_detects_non_gzip(tmp_path: Path) -> None:
    path = tmp_path / "factoreye-1.sql.gz"
    path.write_bytes(b"plain text, not gzip")

    assert not verify(FetchedBackup(path, None)).gzip_ok


class _FakeS3:
    """S3Source が使う呼び出しだけを持つ、手元の偽物。"""

    def __init__(self, objects: dict[str, bytes]) -> None:
        self.objects = objects

    def get_paginator(self, _: str) -> "_FakeS3":
        return self

    def paginate(self, Bucket: str, Prefix: str) -> list[dict[str, object]]:  # noqa: N803
        contents = [
            {"Key": k, "Size": len(v), "LastModified": datetime(2026, 10, i + 1, tzinfo=UTC)}
            for i, (k, v) in enumerate(sorted(self.objects.items()))
            if k.startswith(Prefix)
        ]
        return [{"Contents": contents}]

    def download_file(self, bucket: str, key: str, dest: str) -> None:
        Path(dest).write_bytes(self.objects[key])

    def get_object(self, Bucket: str, Key: str) -> dict[str, io.BytesIO]:  # noqa: N803
        if Key not in self.objects:
            # 読むだけの鍵では、無いキーに AccessDenied が返る
            raise ClientError({"Error": {"Code": "AccessDenied"}}, "GetObject")
        return {"Body": io.BytesIO(self.objects[Key])}


def test_s3_list_and_fetch(tmp_path: Path) -> None:
    data = gzip.compress(b"SELECT 1;")
    digest = hashlib.sha256(data).hexdigest()
    fake = _FakeS3({
        "fe/factoreye-1.sql.gz": data,
        "fe/factoreye-1.sql.gz.sha256": f"{digest}  factoreye-1.sql.gz".encode(),
        "fe/factoreye-2.sql.gz": data,
        "other/factoreye-9.sql.gz": data,
    })
    source = S3Source(fake, "bucket", "fe/", tmp_path)  # type: ignore[arg-type]

    assert [e.name for e in source.list()] == ["factoreye-2.sql.gz", "factoreye-1.sql.gz"]
    with_sum = source.fetch("factoreye-1.sql.gz")
    without_sum = source.fetch("factoreye-2.sql.gz")

    assert with_sum.path.read_bytes() == data
    assert with_sum.expected_sha256 == digest
    assert without_sum.expected_sha256 is None
    assert with_sum.temporary
    assert source.describe() == "s3://bucket/fe"


def test_make_source_local(tmp_path: Path) -> None:
    assert isinstance(make_source(str(tmp_path), tmp_path), LocalSource)


def test_make_source_s3_requires_bucket(tmp_path: Path) -> None:
    with pytest.raises(SourceError):
        make_source("s3://", tmp_path)


def test_csv_cell_neutralizes_formulas() -> None:
    from recovery.dbinfo import MASK, to_csv_cell

    assert to_csv_cell("name", "=HYPERLINK(\"http://x\")").startswith("'=")
    assert to_csv_cell("name", "@SUM(A1)") == "'@SUM(A1)"
    assert to_csv_cell("value", -1.5) == "-1.5"  # 数値はそのまま
    assert to_csv_cell("password_hash", "=secret") == MASK


def test_composite_requires_primary_but_not_optional(tmp_path: Path) -> None:
    from recovery.sources import CompositeSource

    write_dump(tmp_path, "factoreye-1.sql.gz")
    ok = CompositeSource([LocalSource(tmp_path)], optional=[LocalSource(tmp_path / "none")])
    assert [e.name for e in ok.list()] == ["factoreye-1.sql.gz"]

    broken = CompositeSource([LocalSource(tmp_path / "typo")], optional=[])
    with pytest.raises(SourceError):
        broken.list()
