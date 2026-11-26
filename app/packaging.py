"""Đóng gói chứng cứ thành forensic archive + manifest SHA256 + verify.
Chạy trong container be; nguồn là thư mục (uploads case / evidence mount). Không block device.
"""
import hashlib
import json
import tarfile
import time
from pathlib import Path

from . import indexer
from .db import db, next_id


def _set(row_id, **cols):
    db.packages.update_one({"id": row_id}, {"$set": cols})


def _file_entries(source: Path):
    """(relpath str, abs path, size) cho mọi file thường trong source (đệ quy). Hash tính lúc đóng gói (đọc 1 lượt)."""
    out = []
    for p in sorted(source.rglob("*")):
        if p.is_file():
            rel = str(p.relative_to(source)).replace("\\", "/")
            out.append((rel, p, p.stat().st_size))
    return out


class _HashWriter:
    """Ghi ra file đồng thời tính SHA256 của archive: không phải đọc lại 40 GB để hash."""

    def __init__(self, f):
        self.f, self.h = f, hashlib.sha256()

    def write(self, b):
        self.f.write(b)
        self.h.update(b)
        return len(b)

    def flush(self):
        self.f.flush()


class _HashReader:
    """Đọc file nguồn cho tar đồng thời tính SHA256 từng file (manifest): mỗi byte chỉ đọc đúng 1 lần."""

    def __init__(self, f):
        self.f, self.h = f, hashlib.sha256()

    def read(self, n=-1):
        b = self.f.read(n)
        self.h.update(b)
        return b


def create_package(case_name, source_root, dest_dir, progress=None):
    """Đóng gói thư mục nguồn -> dest/<case>-<ts>.tar + .manifest.json. Trả (row_id, archive, manifest).
    Không nén: ảnh/video/jxl đã nén sẵn (gzip chỉ bớt ~3% nhưng tốn 10+ phút CPU đơn luồng cho 40 GB);
    một lượt đọc duy nhất: hash từng file + ghi tar + hash archive cùng lúc. progress(bytes_done, bytes_total)."""
    source_root = Path(source_root)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in case_name)
    arc = dest_dir / f"{safe}-{ts}.tar"
    man = dest_dir / f"{safe}-{ts}.manifest.json"

    row_id = next_id("packages")
    db.packages.insert_one({"id": row_id, "case_name": case_name, "source": str(source_root), "name": arc.name, "size": 0,
                            "sha256": "", "status": "running", "error": None, "log": None, "created_at": indexer.now()})

    entries = _file_entries(source_root)
    total = sum(s for _, _, s in entries) or 1
    files, done = [], 0
    _set(row_id, log=f"Đang đóng gói {len(entries)} file…")
    try:
        with arc.open("wb", buffering=1 << 20) as raw:
            hw = _HashWriter(raw)
            with tarfile.open(fileobj=hw, mode="w|", format=tarfile.PAX_FORMAT, bufsize=1 << 20) as tf:
                tf.copybufsize = 1 << 20
                for rel, abs_path, size in entries:
                    ti = tf.gettarinfo(str(abs_path), arcname=rel)
                    with abs_path.open("rb") as f:
                        hr = _HashReader(f)
                        tf.addfile(ti, hr)
                    files.append({"rel": rel, "size": ti.size, "sha256": hr.h.hexdigest()})
                    done += size
                    if progress:
                        progress(done, total)
        manifest = {"case": case_name, "source": str(source_root), "created_at": indexer.now(), "files": files}
        man.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        _set(row_id, status="done", size=arc.stat().st_size, sha256=hw.h.hexdigest(),
             log=f"Xong: {arc.name} ({arc.stat().st_size:,} bytes)")
    except Exception as e:
        _set(row_id, status="error", error=str(e), log=f"Lỗi: {e}")
        arc.unlink(missing_ok=True)
        man.unlink(missing_ok=True)
        raise
    return row_id, arc, manifest


def verify_package(archive_path: Path, manifest_path: Path):
    """Xác minh archive vs manifest. Trả (ok, danh sách rel bị lệch hash)."""
    man = json.loads(manifest_path.read_text(encoding="utf-8"))
    mism = []
    with tarfile.open(archive_path, "r:*") as tf:  # .tar mới và .tar.gz cũ đều đọc được
        for f in man["files"]:
            m = tf.extractfile(f["rel"])
            if m is None:
                mism.append(f["rel"]); continue
            h = hashlib.sha256()
            for chunk in iter(lambda: m.read(1 << 20), b""):
                h.update(chunk)
            if h.hexdigest() != f["sha256"]:
                mism.append(f["rel"])
    return (not mism), mism