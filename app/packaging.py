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
    """(relpath str, abs path, size, sha256) cho mọi file thường trong source (đệ quy)."""
    out = []
    for p in sorted(source.rglob("*")):
        if p.is_file():
            rel = str(p.relative_to(source)).replace("\\", "/")
            out.append((rel, p, p.stat().st_size, indexer.sha256(p)))
    return out


def create_package(case_name, source_root, dest_dir):
    """Đóng gói thư mục nguồn -> dest/<case>-<ts>.tar.gz + .manifest.json. Trả (row_id, archive, manifest)."""
    source_root = Path(source_root)
    dest_dir = Path(dest_dir)
    dest_dir.mkdir(parents=True, exist_ok=True)
    ts = time.strftime("%Y%m%d-%H%M%S")
    safe = "".join(c if c.isalnum() or c in "-_" else "_" for c in case_name)
    arc = dest_dir / f"{safe}-{ts}.tar.gz"
    man = dest_dir / f"{safe}-{ts}.manifest.json"

    row_id = next_id("packages")
    db.packages.insert_one({"id": row_id, "case_name": case_name, "source": str(source_root), "name": arc.name, "size": 0,
                            "sha256": "", "status": "running", "error": None, "log": None, "created_at": indexer.now()})

    entries = _file_entries(source_root)
    manifest = {"case": case_name, "source": str(source_root), "created_at": indexer.now(),
                "files": [{"rel": r, "size": s, "sha256": h} for (r, _, s, h) in entries]}
    _set(row_id, log=f"Đang đóng gói {len(entries)} file…")

    arc_sha = hashlib.sha256()
    try:
        with tarfile.open(arc, "w:gz") as tf:
            for rel, abs_path, _, _ in entries:
                tf.add(abs_path, arcname=rel)
        with arc.open("rb") as f:
            for chunk in iter(lambda: f.read(1 << 20), b""):
                arc_sha.update(chunk)
        man.write_text(json.dumps(manifest, ensure_ascii=False), encoding="utf-8")
        _set(row_id, status="done", size=arc.stat().st_size, sha256=arc_sha.hexdigest(),
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
    with tarfile.open(archive_path, "r:gz") as tf:
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