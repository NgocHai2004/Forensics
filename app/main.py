import hashlib
import hmac
import json
import os
import plistlib
import re
import secrets
import shutil
import sqlite3
import subprocess
import threading
import time
from pathlib import Path

from typing import Literal

from fastapi import FastAPI, File, Form, HTTPException, Query, UploadFile
from fastapi import Path as PathParam
import csv, io
from fastapi.responses import FileResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from . import indexer, llm, packaging, retrieval
from .db import db, next_id
from pymongo.errors import DuplicateKeyError

app = FastAPI()
DATA = Path(os.environ.get("MF_DATA", "./data")).resolve()
conn = indexer.init_db(str(DATA / "index.db"))
db.index_runs.update_many({"status": "running"}, {"$set": {"status": "error", "message": "bị ngắt", "finished_at": indexer.now()}})  # server chết giữa chừng -> không treo 'running'
DIST = Path(__file__).parent / "static" / "dist"  # build React: cd web && npm run build
if (DIST / "assets").is_dir():
    app.mount("/assets", StaticFiles(directory=DIST / "assets"), name="assets")
lock = threading.Lock()  # ponytail: one global index lock; per-folder locks if parallel scans ever matter
current_thread = None
FileId = PathParam(ge=1, le=2**62)
UPLOADS = DATA / "uploads"
PACKAGES = DATA / "packages"
UPLOAD_MAX = int(os.environ.get("UPLOAD_MAX_MB", "2048")) << 20
MIN_FREE = 5 << 30  # chừa 5 GB cho SQLite WAL/ollama/docker


def allowed(p: Path) -> bool:
    """Chỉ index/phục vụ chứng cứ (/evidence, mount ro) và file tải lên; chặn /etc, /dev, symlink trỏ ra ngoài."""
    return p.is_relative_to("/evidence") or p.is_relative_to(UPLOADS)


class IndexReq(BaseModel):
    folder: str
    collection: str | None = None
    device: str | None = None  # thiết bị thu giữ (devices.name) của vụ án


class Msg(BaseModel):
    role: Literal["user", "assistant"]
    content: str


class AskReq(BaseModel):
    question: str
    history: list[Msg] = []
    collection: str | None = None
    extra: list[str] = []  # vụ án khác được thêm vào để hỏi cùng


class CaseReq(BaseModel):
    name: str
    note: str | None = None


class DeviceReq(BaseModel):
    case: str
    name: str
    type: Literal["laptop", "hdd", "phone", "camera", "video", "other"]  # 6 nhóm thiết bị theo sơ đồ thu thập
    note: str | None = None


def with_urls(f):
    f = dict(f)
    f["thumb_url"] = f"/thumb/{f['id']}" if f.get("thumb") else None
    f["file_url"] = f"/file/{f['id']}"
    return f


@app.get("/")
def home():
    return FileResponse(DIST / "index.html")  # dist được build trong Dockerfile stage 1


@app.get("/api/stats")
def stats():
    return indexer.stats(conn)


@app.get("/api/files")
def files(kind: str | None = None, q: str | None = None, collection: str | None = None, device: str | None = None,
          page: int = Query(1, ge=1), limit: int = Query(60, ge=1, le=200)):
    r = indexer.list_files(_rconn(), kind, q, page, limit, collection, device)
    r["items"] = [with_urls(f) for f in r["items"]]
    return r


# Khớp storeOf() ở CaseDetail.tsx: system > apk > archive > appdata > kind
_STORE_CASE = """CASE
  WHEN INSTR(path, '/_chat/') > 0 THEN 'chat'
  WHEN INSTR(path, '/_aqf/') > 0 OR name = 'sim.txt' THEN 'system'
  WHEN LOWER(LTRIM(ext, '.')) = 'apk' THEN 'apk'
  WHEN LOWER(LTRIM(ext, '.')) IN ('zip','rar','7z','tar','gz','tgz','bz2','xz') THEN 'archive'
  WHEN LOWER(LTRIM(ext, '.')) IN ('sqlite','sqlite3','db','plist','json','xml') THEN 'appdata'
  ELSE kind END"""
_STORE_SQL = "SELECT " + _STORE_CASE + " AS k, COUNT(*), COALESCE(SUM(size), 0) FROM files WHERE collection = ? {dev} {cloud} GROUP BY k"
STORE_KEYS = ("chat", "image", "video", "audio", "document", "archive", "apk", "appdata", "system", "other")


_CLOUD_SQL = "AND (" + " OR ".join(f"LOWER(path) LIKE '%{k}%'" for k in (
    "cloud", "dropbox", "onedrive", "skydrive", "mobile documents", "com.google.android.apps.docs", "com.google.android.apps.photos")) + ")"


@app.get("/api/files/stats")
def files_stats(collection: str, device: str | None = None, cloud: bool = False):
    by = {k: {"n": 0, "size": 0} for k in STORE_KEYS}
    for k, n, size in _rconn().execute(_STORE_SQL.format(dev="AND device = ?" if device else "", cloud=_CLOUD_SQL if cloud else ""),
                                       [collection] + ([device] if device else [])):
        by[k if k in by else "other"] = {"n": n, "size": size}
    return {"by": by, "n": sum(x["n"] for x in by.values()), "size": sum(x["size"] for x in by.values())}


# Nhóm "Đối tượng" của ảnh/video kiểu app Ảnh iPhone: tag AI (khớp chuỗi con), OCR, GPS; không thuộc nhóm nào -> "other".
# Nguồn duy nhất: CaseDetail.tsx chỉ giữ key + nhãn, số đếm và danh sách lấy từ /api/files/objects và /api/files/browse.
OBJ_KW = {
    "person": ("người", "khuôn mặt", "trẻ em", "học sinh", "phụ nữ", "đàn ông", "em bé", "selfie", "khẩu trang", "đám đông"),
    "vehicle": ("xe máy", "ô tô", "xe hơi", "xe tải", "xe đạp", "biển số", "phương tiện"),
    "qr": ("qr", "mã vạch", "barcode"),
    "paper": ("tài liệu", "văn bản", "giấy tờ", "hóa đơn", "biên lai", "căn cước", "cccd", "chứng minh", "hợp đồng"),
    "money": ("chuyển tiền", "giao dịch", "ngân hàng", "momo", "thanh toán", "số tiền", "tiền mặt", "pos"),
    "screen": ("màn hình", "giao diện", "ứng dụng", "đăng nhập", "mật khẩu", "app"),
}
OBJ_KEYS = (*OBJ_KW, "gps", "text", "other")


def _objs(tags, ocr, lat):
    try:
        t = json.loads(tags or "[]")
    except ValueError:
        t = []  # tag hỏng: coi như không có tag
    t = "\n".join(str(x).lower() for x in t) if isinstance(t, list) else ""
    o = (ocr or "").lower()
    hit = [k for k, kw in OBJ_KW.items() if any(w in (f"{t}\n{o}" if k == "qr" else t) for w in kw)]
    if lat is not None:
        hit.append("gps")
    if o.strip():
        hit.append("text")
    return hit or ["other"]


# Nguồn của tệp = app/thư mục lấy được: iOS theo domain trong _ios_files, Android theo thư mục dưới /sdcard
_APPS = (("zingalo", "Zalo"), ("zalo", "Zalo"), ("facebook.messenger", "Messenger"), ("facebook.orca", "Messenger"),
         ("facebook", "Facebook"), ("telegram", "Telegram"), ("whatsapp", "WhatsApp"), ("tencent.xin", "WeChat"), ("wechat", "WeChat"),
         ("tencent.mm", "WeChat"), ("linecorp", "LINE"), ("naver.line", "LINE"), ("instagram", "Instagram"),
         ("musically", "TikTok"), ("zhiliaoapp", "TikTok"), ("tiktok", "TikTok"), ("viber", "Viber"), ("skype", "Skype"),
         ("imessage", "Tin nhắn iMessage"))
_SRC_RE = re.compile(r"/_ios_files/([^/]+)/|/sdcard/(?:Android/(?:data|media|obb)/([^/]+)/|([^/]+)/)")


def _src(path: str) -> str:
    if "/_records/" in path:  # danh bạ / cuộc gọi / ghi chú do _records_export xuất
        return "Ghi chú" if "/_records/ghi_chu/" in path else "Danh bạ & Cuộc gọi"
    if c := re.search(r"/_chat/([^/]+)/", path):  # hội thoại xuất từ CSDL app (_zalo_export)
        return next((label for k, label in _APPS if k in c[1].lower()), c[1])
    m = _SRC_RE.search(path)
    if not m:
        return "Khác"
    ios, pkg, top = m.groups()
    sid = (ios or pkg or top).lower()
    for k, label in _APPS:
        if k in sid:
            return label
    if ios:
        if sid == "camerarolldomain":
            return "Camera / Ảnh"
        if sid == "mediadomain" and "/library/sms/" in path.lower():
            return "Tin nhắn iMessage"
        if not sid.startswith("appdomain"):
            return "Hệ thống iOS"
        return re.sub(r"^appdomain(group|plugin)?-(group\.)?", "", sid)
    if pkg:
        return pkg
    return {"dcim": "Camera / Ảnh", "download": "Tải về"}.get(sid, top)


def _scan_files(collection, device, store, cloud, q, date_from, date_to, src=None):
    """(id, nhóm đối tượng hoặc None nếu không phải ảnh/video) của mọi tệp khớp bộ lọc, mới nhất trước.
    Quét cả vụ án vì trang chỉ nạp 20.000 tệp mới nhất (~0,45 s cho máy 75.000 tệp)."""
    # shortcut: quét lại mỗi request, không cache; thêm cache theo (bộ lọc, COUNT, MAX(id)) nếu một máy lên vài trăm nghìn tệp
    if store and store not in STORE_KEYS:
        raise HTTPException(400, "store không hợp lệ")
    w, a = ["collection = ?"], [collection]
    for cond, v in (("device = ?", device), ("substr(COALESCE(taken_at, mtime), 1, 10) >= ?", date_from),
                    ("substr(COALESCE(taken_at, mtime), 1, 10) <= ?", date_to)):
        if v:
            w.append(cond)
            a.append(v)
    if store == "other":  # loại không có tên riêng, giống files_stats gộp vào "other"
        known = [k for k in STORE_KEYS if k != "other"]
        w.append(f"({_STORE_CASE}) NOT IN ({','.join('?' * len(known))})")
        a += known
    elif store:
        w.append(f"({_STORE_CASE}) = ?")
        a.append(store)
    sql = (f"SELECT id, kind, tags, ocr_text, lat, path, name, caption, substr(text_content, 1, 160) FROM files "
           f"WHERE {' AND '.join(w)} {_CLOUD_SQL if cloud else ''} ORDER BY COALESCE(taken_at, mtime) DESC")
    ql = (q or "").strip().lower()
    for i, kind, tags, ocr, lat, path, *text in _rconn().execute(sql, a):
        if ql and not any(ql in (s or "").lower() for s in (ocr, *text)):
            continue
        s = _src(path)
        if src and s != src:
            continue
        yield i, (_objs(tags, ocr, lat) if kind in ("image", "video") else None), s


@app.get("/api/files/objects")
def files_objects(collection: str, device: str | None = None, store: str | None = None, cloud: bool = False,
                  q: str | None = None, date_from: str | None = None, date_to: str | None = None, src: str | None = None):
    """Số ảnh/video mỗi nhóm đối tượng; "all" = tổng ảnh/video (một ảnh có thể thuộc nhiều nhóm)."""
    c = dict.fromkeys((*OBJ_KEYS, "all"), 0)
    for _, objs, _s in _scan_files(collection, device, store, cloud, q, date_from, date_to, src):
        if objs:
            c["all"] += 1
            for k in objs:
                c[k] += 1
    return c


@app.get("/api/files/apps")
def files_apps(collection: str, device: str | None = None, cloud: bool = False):
    """Cây Nguồn -> loại tệp: [{src, n, size, by: {loại: [số tệp, byte]}}], nguồn nhiều tệp nhất trước."""
    w, a = "collection = ?", [collection]
    if device:
        w, a = w + " AND device = ?", a + [device]
    out: dict[str, dict] = {}
    for path, size, k in _rconn().execute(f"SELECT path, size, {_STORE_CASE} FROM files WHERE {w} {_CLOUD_SQL if cloud else ''}", a):
        o = out.setdefault(_src(path), {"n": 0, "size": 0, "by": {}})
        k = k if k in STORE_KEYS else "other"
        x = o["by"].setdefault(k, [0, 0])
        x[0] += 1
        x[1] += size or 0
        o["n"] += 1
        o["size"] += size or 0
    # nguồn có hội thoại hoặc danh bạ lên đầu, còn lại theo số tệp
    return sorted(({"src": s, **o} for s, o in out.items()),
                  key=lambda r: (not ("chat" in r["by"] or r["src"] == "Danh bạ & Cuộc gọi"), -r["n"]))


@app.get("/api/files/sources")
def files_sources(collection: str, device: str | None = None, store: str | None = None, obj: str | None = None,
                  cloud: bool = False, q: str | None = None, date_from: str | None = None, date_to: str | None = None):
    """Số tệp theo nguồn (app / thư mục lấy được) cho bộ lọc hiện tại, nhiều nhất trước."""
    c: dict[str, int] = {}
    for _, objs, s in _scan_files(collection, device, store, cloud, q, date_from, date_to):
        if not obj or obj in (objs or ()):
            c[s] = c.get(s, 0) + 1
    return sorted(c.items(), key=lambda x: -x[1])


@app.get("/api/files/browse")
def files_browse(collection: str, device: str | None = None, store: str | None = None, obj: str | None = None,
                 cloud: bool = False, q: str | None = None, date_from: str | None = None, date_to: str | None = None,
                 src: str | None = None, page: int = Query(1, ge=1), limit: int = Query(200, ge=1, le=200)):
    """Một trang tệp khớp bộ lọc (loại tệp, đối tượng, ngày, từ khóa) trên toàn bộ vụ án, mới nhất trước."""
    if obj and obj not in OBJ_KEYS:
        raise HTTPException(400, "obj không hợp lệ")
    ids = [i for i, objs, _s in _scan_files(collection, device, store, cloud, q, date_from, date_to, src) if not obj or obj in (objs or ())]
    pick = ids[(page - 1) * limit:page * limit]
    rows = {r["id"]: r for r in _rconn().execute(f"SELECT * FROM files WHERE id IN ({','.join('?' * len(pick))})", pick)}
    return {"items": [with_urls(rows[i]) for i in pick if i in rows], "total": len(ids), "page": page, "limit": limit}


@app.get("/api/collections")
def list_collections():
    return indexer.collections(conn)


@app.get("/api/cases")
def list_cases():
    return indexer.cases(conn)


@app.post("/api/cases")
def create_case(req: CaseReq):
    name = clean_name(req.name)
    if not name:
        raise HTTPException(400, "thiếu tên vụ án")
    if any(c["name"] == name for c in indexer.cases(conn)):  # kể cả vụ án mới chỉ có trong files
        raise HTTPException(409, "vụ án đã tồn tại")
    db.cases.insert_one({"name": name, "note": (req.note or "").strip()[:500] or None, "created_at": indexer.now()})
    _audit(conn, "case.create", name, (req.note or "").strip()[:200])
    return next(c for c in indexer.cases(conn) if c["name"] == name)


class CaseEditReq(BaseModel):
    name: str
    new_name: str
    note: str | None = None


class CaseDelReq(BaseModel):
    name: str


def _case_idle(name):
    """Gọi trong `with lock`: luồng index đang chạy giữ tên vụ án cũ nên không cho sửa/xoá giữa chừng."""
    if current_thread and current_thread.is_alive():
        raise HTTPException(409, "đang index, thử lại sau")
    if not any(c["name"] == name for c in indexer.cases(conn)):
        raise HTTPException(404, "không có vụ án")


@app.post("/api/cases/update")
def update_case(req: CaseEditReq):
    new = clean_name(req.new_name)
    if not new:
        raise HTTPException(400, "thiếu tên vụ án")
    with lock:
        _case_idle(req.name)
        if new != req.name and any(c["name"] == new for c in indexer.cases(conn)):
            raise HTTPException(409, "vụ án đã tồn tại")
        # vụ án chỉ có trong files: tạo dòng cases, giữ ngày tạo cũ
        first = conn.execute("SELECT MIN(indexed_at) FROM files WHERE collection=?", (req.name,)).fetchone()[0]
        db.cases.update_one({"name": req.name}, {"$setOnInsert": {"created_at": first or indexer.now()}}, upsert=True)
        db.cases.update_one({"name": req.name}, {"$set": {"name": new, "note": (req.note or "").strip()[:500] or None}})
        db.devices.update_many({"case_name": req.name}, {"$set": {"case_name": new}})
        with conn:
            conn.execute("UPDATE files SET collection=? WHERE collection=?", (new, req.name))
    _audit(conn, "case.rename", f"{req.name} -> {new}")
    # shortcut: file đã tải lên vẫn nằm ở data/uploads/<tên cũ>/ (đường dẫn trong DB vẫn đúng); file mới vào thư mục tên mới
    return next(c for c in indexer.cases(conn) if c["name"] == new)


@app.post("/api/cases/delete")
def delete_case(req: CaseDelReq):
    """Xoá vụ án khỏi hệ thống. Dữ liệu gốc ở /evidence (chỉ đọc) không đụng tới; bản tải lên chuyển vào data/trash/."""
    with lock:
        _case_idle(req.name)
        rows = conn.execute("SELECT path, thumb FROM files WHERE collection=?", (req.name,)).fetchall()
        with conn:
            conn.execute("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE collection=?)", (req.name,))
            conn.execute("DELETE FROM files WHERE collection=?", (req.name,))
        db.devices.delete_many({"case_name": req.name})
        db.cases.delete_one({"name": req.name})
    _audit(conn, "case.delete", req.name)
    return _to_trash(rows)


def _to_trash(rows):
    """rows (path, thumb) đã xoá khỏi DB: bỏ thumbnail, chuyển bản tải lên vào data/trash/; /evidence chỉ đọc nên không đụng."""
    trash, moved = DATA / "trash" / indexer.now().replace(":", ""), 0
    for path, thumb in rows:
        if thumb:
            (DATA / thumb).unlink(missing_ok=True)
        p = Path(path).resolve()
        if p.is_relative_to(UPLOADS.resolve()) and p.is_file():
            dst = trash / p.relative_to(UPLOADS.resolve())
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.move(p, dst)
            moved += 1
    return {"deleted": len(rows), "trashed": moved, "trash": str(trash) if moved else None}


@app.get("/api/devices")
def list_devices(case: str):
    # kết nối SQLite riêng mỗi request: trang poll 2s, dùng chung `conn` giữa các luồng gây sqlite3.InterfaceError
    # shortcut: các endpoint khác vẫn dùng conn chung; đổi sang kết nối theo luồng nếu lỗi này còn ở chỗ khác
    c = sqlite3.connect(str(DATA / "index.db"))
    try:
        r = indexer.devices(c, case)
        sizes = dict(c.execute("SELECT device, SUM(size) FROM files WHERE collection=? GROUP BY device", (case,)).fetchall())
    finally:
        c.close()
    for d in r["items"]:  # trạng thái lâu dài suy từ dữ liệu thật: có gói image (+SHA256) / đã có file trích xuất
        pkg = db.packages.find_one({"source": str(UPLOADS / case / d["name"]), "status": "done"},
                                   {"_id": 0, "sha256": 1, "name": 1}, sort=[("id", -1)]) or {}
        src = UPLOADS / case / d["name"]
        # lần trích xuất (index) gần nhất của thư mục này: bị ngắt/lỗi -> 'partial' (có nút Tiếp tục), không phải 'done'
        run = db.index_runs.find_one({"folder": str(src)}, {"_id": 0, "status": 1, "done": 1, "total": 1, "message": 1},
                                     sort=[("_id", -1)])
        finished = bool(run and run["status"] == "done")
        d.update(image_sha256=pkg.get("sha256"), image_name=pkg.get("name"),
                 stage=("done" if finished else "partial") if d["count"] else "imaged" if pkg else "new",
                 size=sizes.get(d["name"]) or 0, info=_dev_info(src), index_run=run)
        if not finished:  # chưa trích xuất xong: báo dữ liệu thô đã thu về để so với phần đã trích xuất
            key = (str(src), d["image_sha256"])
            if key not in _raw_cache:  # trang poll 2s; sau khi đóng image thư mục không đổi tới lúc trích xuất
                _raw_cache[key] = _tree(src) if src.is_dir() else (0, 0)
            d["raw_count"], d["raw_size"] = _raw_cache[key]
    return r


_raw_cache: dict = {}  # shortcut: không bao giờ xoá, nhỏ (1 mục / thiết bị / image); đổi sang LRU nếu số vụ án rất lớn


@app.post("/api/devices")
def create_device(req: DeviceReq):
    name = clean_name(req.name)
    if not name:
        raise HTTPException(400, "thiếu tên thiết bị")
    if not any(c["name"] == req.case for c in indexer.cases(conn)):
        raise HTTPException(404, "không có vụ án")
    note = (req.note or "").strip()[:200] or None
    # thiết bị đã có -> cập nhật loại/ghi chú (giữ ngày tạo + tài liệu cũ), chưa có -> thêm mới
    db.devices.update_one({"case_name": req.case, "name": name},
                          {"$set": {"type": req.type, **({"note": note} if note else {})},
                           "$setOnInsert": {"created_at": indexer.now(), **({} if note else {"note": None})}}, upsert=True)
    _audit(conn, "device.create", f"{req.case}/{name}", req.type)
    return next(d for d in indexer.devices(conn, req.case)["items"] if d["name"] == name)


class DeviceDelReq(BaseModel):
    case: str
    name: str


@app.post("/api/devices/delete")
def delete_device(req: DeviceDelReq):
    """Xoá thiết bị khỏi vụ án cùng tài liệu của nó; bản tải lên/kéo về chuyển vào data/trash/."""
    with lock:
        if (current_thread and current_thread.is_alive()) or any(s["running"] for s in _all_states().values()):
            raise HTTPException(409, "đang index hoặc kéo dữ liệu, thử lại sau")
        if req.name not in [d["name"] for d in indexer.devices(conn, req.case)["items"]]:
            raise HTTPException(404, "không có thiết bị")
        key = (req.case, req.name)
        rows = conn.execute("SELECT path, thumb FROM files WHERE collection=? AND device=?", key).fetchall()
        with conn:
            conn.execute("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE collection=? AND device=?)", key)
            conn.execute("DELETE FROM files WHERE collection=? AND device=?", key)
        db.devices.delete_one({"case_name": req.case, "name": req.name})
    _audit(conn, "device.delete", f"{req.case}/{req.name}")
    return _to_trash(rows)


class FileDelReq(BaseModel):
    case: str
    id: int


@app.post("/api/files/delete")
def delete_file(req: FileDelReq):
    """Xoá một tài liệu khỏi vụ án; bản tải lên chuyển vào data/trash/."""
    with lock:
        if (current_thread and current_thread.is_alive()) or any(s["running"] for s in _all_states().values()):
            raise HTTPException(409, "đang index hoặc kéo dữ liệu, thử lại sau")
        r = conn.execute("SELECT path, thumb FROM files WHERE collection=? AND id=?", (req.case, req.id)).fetchone()
        if not r:
            raise HTTPException(404, "không có tài liệu")
        with conn:
            conn.execute("DELETE FROM chunks WHERE file_id=?", (req.id,))
            conn.execute("DELETE FROM files WHERE id=?", (req.id,))
    _audit(conn, "file.delete", f"{req.case}/{req.id}")
    return _to_trash([r])


# idVendor các hãng điện thoại phổ biến (nhận ở mọi chế độ USB, không cần adb).
PHONE_VENDORS = {
    "18d1",  # Google / Android
    "04e8",  # Samsung
    "2717",  # Xiaomi
    "22d9",  # Oppo / Oplus / realme
    "2d95",  # Vivo
    "12d1",  # Huawei
    "2a70",  # OnePlus
    "05ac",  # Apple
    "0fce",  # Sony
    "1004",  # LG
    "22b8",  # Motorola
    "0bb4",  # HTC
    "19d2",  # ZTE
    "17ef",  # Lenovo
    "0e8d",  # MediaTek (nhiều máy TQ)
}


def _usb_field(d: Path, name: str) -> str:
    try:
        return (d / name).read_text().strip()
    except OSError:
        return ""


# --- Anh thuc te cua thiet bi: tra model chuan (adb/ideviceinfo) roi query DDG Images, cache xuong disk ---
import urllib.request
import urllib.parse

IPHONE_PT = {
    "iPhone8,1": "iPhone 6s", "iPhone8,2": "iPhone 6s Plus", "iPhone8,4": "iPhone SE", "iPhone9,1": "iPhone 7",
    "iPhone9,2": "iPhone 7 Plus", "iPhone9,3": "iPhone 7", "iPhone9,4": "iPhone 7 Plus", "iPhone10,1": "iPhone 8",
    "iPhone10,4": "iPhone 8", "iPhone10,2": "iPhone 8 Plus", "iPhone10,5": "iPhone 8 Plus", "iPhone10,3": "iPhone X",
    "iPhone10,6": "iPhone X", "iPhone11,2": "iPhone XS", "iPhone11,4": "iPhone XS Max", "iPhone11,6": "iPhone XS Max",
    "iPhone11,8": "iPhone XR", "iPhone12,1": "iPhone 11", "iPhone12,3": "iPhone 11 Pro", "iPhone12,5": "iPhone 11 Pro Max",
    "iPhone12,8": "iPhone SE 2nd gen", "iPhone13,1": "iPhone 12 mini", "iPhone13,2": "iPhone 12", "iPhone13,3": "iPhone 12 Pro",
    "iPhone13,4": "iPhone 12 Pro Max", "iPhone14,2": "iPhone 13 Pro", "iPhone14,3": "iPhone 13 Pro Max", "iPhone14,4": "iPhone 13 mini",
    "iPhone14,5": "iPhone 13", "iPhone14,6": "iPhone SE 3rd gen", "iPhone14,7": "iPhone 14", "iPhone14,8": "iPhone 14 Plus",
    "iPhone15,2": "iPhone 14 Pro", "iPhone15,3": "iPhone 14 Pro Max", "iPhone15,4": "iPhone 15", "iPhone15,5": "iPhone 15 Plus",
    "iPhone16,1": "iPhone 15 Pro", "iPhone16,2": "iPhone 15 Pro Max", "iPhone17,1": "iPhone 16 Pro", "iPhone17,2": "iPhone 16 Pro Max",
    "iPhone17,3": "iPhone 16", "iPhone17,4": "iPhone 16 Plus", "iPhone17,5": "iPhone 16e",
}
IPAD_PT = {
    "iPad13,1": "iPad Air 4th gen", "iPad13,2": "iPad Air 4th gen", "iPad13,16": "iPad Air 5th gen", "iPad13,17": "iPad Air 5th gen",
    "iPad13,4": "iPad Pro 11 3rd gen", "iPad13,5": "iPad Pro 11 3rd gen", "iPad14,2": "iPad mini 6th gen", "iPad13,8": "iPad Pro 12.9 5th gen",
}

def _device_query(serial: str, ios: bool, name: str) -> str:
    """Tra ten thuong mai chinh xac (cho query search anh). Tra ve chuoi co the rong."""
    try:
        if ios:
            pt = subprocess.run(["ideviceinfo", "-k", "ProductType"], capture_output=True, text=True, timeout=30).stdout.strip()
            if pt in IPAD_PT:
                return IPAD_PT[pt]
            if pt in IPHONE_PT:
                return IPHONE_PT[pt]
            return "iPad" if pt.startswith("iPad") else (pt or "iPhone")
        if serial:
            def gp(k):
                try:
                    return subprocess.run(["adb", "-s", serial, "shell", "getprop", k], capture_output=True, text=True, timeout=15).stdout.strip()
                except (OSError, subprocess.SubprocessError):
                    return ""
            brand = gp("ro.product.brand") or gp("ro.product.manufacturer")
            model = gp("ro.product.model")
            return gp("ro.product.marketname") or _market_name(model) or (brand + " " + model).strip()
    except (OSError, subprocess.SubprocessError):
        pass
    # máy đã rút cáp: mã model nằm trong tên thiết bị (vd "LENOVO TB305XU") -> tra tên thương mại
    for tok in reversed((name or "").split()):
        if (m := _market_name(tok)):
            return m
    return name or ""


PLAY_CSV = "https://storage.googleapis.com/play_public/supported_devices.csv"
_play_lock = threading.Lock()
_play: dict[str, str] = {}


def _market_name(model: str) -> str:
    """Mã model Android (vd TB305XU) -> tên thương mại chính thức theo danh sách thiết bị Google Play (tải 1 lần ~5 MB)."""
    with _play_lock:
        if not _play:
            try:
                fp = DATA / "deviceimg" / "supported_devices.csv"
                if not fp.exists():
                    fp.parent.mkdir(parents=True, exist_ok=True)
                    fp.write_bytes(urllib.request.urlopen(PLAY_CSV, timeout=60).read())
                raw = fp.read_bytes()
                text = raw.decode("utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8", "ignore")
                for row in csv.reader(io.StringIO(text)):
                    if len(row) == 4 and row[1].strip():
                        brand, market = row[0].strip(), row[1].split(" / ")[0].strip()
                        _play.setdefault(row[3].strip().upper(), market if market.lower().startswith(brand.lower()) else f"{brand} {market}")
            except Exception:  # noqa: BLE001 - không có mạng / CSV hỏng: coi như không tra được, lần sau thử lại
                _play.clear()
                return ""
    return _play.get(model.strip().upper(), "")


WIKI_UA = {"User-Agent": "MobileForensic-device-picture/1.0"}


def _wiki_image(name: str):
    """Ảnh thật của đúng model từ Wikipedia (API chính thức). Chỉ nhận trang có tiêu đề chứa đủ các từ của tên máy;
    không chắc chắn -> None để FE hiện icon (Bing hay trả ảnh sai: slide sinh học, bia...)."""
    words = {w for w in re.findall(r"[a-z0-9]+", name.lower()) if w not in ("inc", "co", "ltd", "corp")}
    q = urllib.parse.urlencode({"action": "query", "format": "json", "generator": "search", "gsrsearch": name, "gsrlimit": 5,
                                "prop": "pageimages", "piprop": "thumbnail", "pithumbsize": 400})
    try:
        r = json.load(urllib.request.urlopen(urllib.request.Request("https://en.wikipedia.org/w/api.php?" + q, headers=WIKI_UA), timeout=20))
        for p in sorted(r.get("query", {}).get("pages", {}).values(), key=lambda p: p.get("index", 99)):
            src = (p.get("thumbnail") or {}).get("source", "")
            if words and src and words <= set(re.findall(r"[a-z0-9]+", p.get("title", "").lower())):
                return urllib.request.urlopen(urllib.request.Request(src, headers=WIKI_UA), timeout=20).read()
    except Exception:  # noqa: BLE001 - không có mạng: FE hiện icon
        pass
    return None


from functools import lru_cache


@lru_cache(maxsize=128)
def _android_info(aqf: str, _mtime: float) -> dict:
    """Thông tin máy Android từ getprop.txt + dòng Data-Free (diskstats) trong dumpsys.txt đã thu. Cache theo mtime."""
    p = dict(re.findall(r"^\[([^\]]+)\]: \[(.*)\]\r?$", (Path(aqf) / "getprop.txt").read_text(errors="replace"), re.M))
    model = p.get("ro.product.model", "")
    info = {"name": p.get("ro.product.marketname") or _market_name(model) or f"{p.get('ro.product.brand', '')} {model}".strip() or None,
            "model": model or None,
            "os": f"Android {p['ro.build.version.release']}" if p.get("ro.build.version.release") else None,
            "patch": p.get("ro.build.version.security_patch") or None,
            "build": p.get("ro.build.display.id") or None,
            "serial": p.get("ro.serialno") or None,
            "sim": p.get("gsm.sim.operator.alpha") or p.get("gsm.operator.alpha") or None}
    ds = Path(aqf) / "dumpsys.txt"
    if ds.exists():
        with ds.open("rb") as f:  # ~20 MB: đọc từng dòng tới dòng diskstats rồi dừng
            for line in f:
                if m := re.match(rb"Data-Free: (\d+)K / (\d+)K total", line):
                    info["storage_free"], info["storage_total"] = int(m[1]) << 10, int(m[2]) << 10
                    break
    return info


@lru_cache(maxsize=128)
def _ios_info(path: str, _mtime: float) -> dict:
    """Thông tin iPhone từ _ios_info.txt (ideviceinfo) đã thu. Cache theo mtime."""
    d = dict(re.findall(r"^(\w+): (.*?)\r?$", Path(path).read_text(errors="replace"), re.M))
    pt = d.get("ProductType", "")
    return {"name": IPHONE_PT.get(pt) or IPAD_PT.get(pt) or d.get("DeviceName") or pt or None,
            "model": d.get("ModelNumber") or pt or None,
            "os": f"iOS {d['ProductVersion']}" if d.get("ProductVersion") else None,
            "serial": d.get("SerialNumber") or None,
            "imei": d.get("InternationalMobileEquipmentIdentity") or None,
            "phone": d.get("PhoneNumber") or None}


def _dev_info(folder: Path) -> dict:
    """Thông tin máy đọc từ dữ liệu đã thu (không cần cắm lại máy); chưa thu / tệp hỏng -> {}."""
    try:
        gp = folder / "_aqf" / "getprop.txt"
        if gp.exists():
            ds = gp.parent / "dumpsys.txt"  # khóa cache gồm cả dumpsys: tệp này ghi sau getprop trong lúc đóng image
            return _android_info(str(gp.parent), max(gp.stat().st_mtime, ds.stat().st_mtime if ds.exists() else 0))
        ios = folder / "_ios_info.txt"
        if ios.exists():
            return _ios_info(str(ios), ios.stat().st_mtime)
    except Exception:  # noqa: BLE001 - đang ghi dở / tệp hỏng: thẻ vẫn hiện, chỉ thiếu thông tin máy
        pass
    return {}


@app.get("/api/device-image")
def device_image(serial: str = "", ios: bool = False, name: str = ""):
    """Ảnh thật đúng model: mã model -> tên thương mại (Google Play) -> ảnh trang Wikipedia khớp tên. 404 => FE hiện icon."""
    q = _device_query(serial, ios, name)
    if not q:
        raise HTTPException(404, "no model")
    ddir = DATA / "deviceimg"
    ddir.mkdir(parents=True, exist_ok=True)
    fp = ddir / (hashlib.md5(("wiki|" + q).encode()).hexdigest() + ".img")  # khóa mới: bỏ qua ảnh Bing sai đã cache
    miss = fp.with_suffix(".none")
    if not fp.exists():
        if miss.exists() and time.time() - miss.stat().st_mtime < 3600:
            raise HTTPException(404, "no image")
        img = _wiki_image(q)
        if not img:
            miss.touch()  # không có ảnh chắc chắn đúng: 1 giờ sau mới tìm lại
            raise HTTPException(404, "no image")
        fp.write_bytes(img)
    head = fp.read_bytes()[:8]
    ctype = "image/jpeg"
    if head.startswith(b"\x89PNG"):
        ctype = "image/png"
    elif head.startswith(b"GIF"):
        ctype = "image/gif"
    elif head.startswith(b"\xff\xd8"):
        ctype = "image/jpeg"
    return Response(content=fp.read_bytes(), media_type=ctype,
                    headers={"Cache-Control": "public, max-age=86400"})

@app.get("/api/usb")
def usb_devices():
    """Thiết bị USB đang cắm trên máy chủ, đọc /sys (không cần adb). Chỉ trả điện thoại và ổ lưu trữ để tự điền form."""
    root = Path("/sys/bus/usb/devices")
    out = []
    adb_state = {x["serial"].lower(): x["state"] for x in _adb_devices()}  # serial adb thường = serial USB
    for d in sorted(root.glob("*")):
        if ":" in d.name or not (d / "idVendor").exists():
            continue  # bỏ interface, chỉ lấy node thiết bị
        if _usb_field(d, "bDeviceClass") == "09":
            continue  # hub
        vendor = _usb_field(d, "idVendor").lower()
        iface = {_usb_field(i, "bInterfaceClass") for i in d.glob(f"{d.name}:*")}
        if "08" in iface:
            dtype = "hdd"  # mass storage: USB/ổ cứng
        elif vendor in PHONE_VENDORS or "06" in iface:
            dtype = "phone"  # vendor điện thoại, hoặc MTP/PTP
        else:
            continue  # webcam, bluetooth, bàn phím, RGB...
        product, maker = _usb_field(d, "product"), _usb_field(d, "manufacturer")
        serial = _usb_field(d, "serial")
        name = product or maker or f"USB {vendor}"
        if maker and product and maker.split()[0].lower() not in product.lower():
            name = f"{maker} {product}"
        out.append({"type": dtype, "name": name.strip()[:60], "model": product.strip()[:60] or None,
                    "serial": serial[:40] or None, "usb_id": f"{vendor}:{_usb_field(d, 'idProduct')}",
                    "ios": vendor == "05ac",
                    # adb: device = đã bật gỡ lỗi USB và cho phép; unauthorized = chờ bấm Cho phép trên máy;
                    # None = chỉ sạc/MTP, chưa bật gỡ lỗi USB (không đọc được gì qua adb)
                    "adb": adb_state.get(serial.lower()) if dtype == "phone" else None})
    return {"items": out}


# Kéo dữ liệu điện thoại qua adb. adb server chạy trên host (giữ USB + uỷ quyền), container nối tới qua ADB_SERVER_SOCKET.
ADB = os.environ.get("ADB", "adb")
# Thư mục chung trong bộ nhớ máy; máy không root: nên dùng /sdcard (ảnh, video, tải về, ghi âm, media của app).
PULL_PATHS = ["/sdcard/"]
# Kéo song song nhiều luồng adb: adb pull hỏi-đáp từng tệp, hàng chục nghìn tệp nhỏ để USB rảnh giữa các tệp
PULL_STREAMS = 3


def _units_from_du(out: str) -> list[str]:
    """Dòng `du -sk` ("KB<TAB>tên") -> tên các mục, lớn trước để các luồng kéo xong gần cùng lúc."""
    rows = [(int(kb), name) for kb, _, name in (line.partition("\t") for line in out.splitlines()) if kb.isdigit() and name]
    return [name for _, name in sorted(rows, reverse=True)]


def _pull_units(serial: str, dest: Path) -> list[tuple[str, Path]]:
    """/sdcard chia theo từng mục; Android/ và Android/data/ tách sâu thêm một cấp (ảnh/tệp Zalo, Telegram... nằm ở đó).
    Hợp các mục = toàn bộ /sdcard như trước. Không liệt kê được -> kéo cả /sdcard một luồng như cũ."""
    sh = ('cd /sdcard/ && for x in * .[!.]* ..?* Android/* Android/data/*; do case "$x" in Android|Android/data) ;; '
          '*) [ -e "$x" ] && du -sk "$x";; esac; done 2>/dev/null')
    try:
        out = subprocess.run([ADB, "-s", serial, "shell", sh], capture_output=True, text=True, timeout=600).stdout
    except (OSError, subprocess.SubprocessError):
        out = ""
    return [(f"/sdcard/{n}", dest / "sdcard" / Path(n).parent) for n in _units_from_du(out)] or [("/sdcard/", dest)]
# Trạng thái kéo theo từng thiết bị (key = vụ án/thiết bị) để nhiều máy chạy song song; serial chỉ cần khi đóng image.
# stage: new (chưa) -> imaging (đang đóng image) -> imaged (đã gói+hash) -> extracting (đang trích) -> done
# phase: count -> pull -> package -> index (đi qua các bước trong 1 stage)
_pull_lock = threading.Lock()
pull_states: dict[str, dict] = {}


def _dev_state(case: str, device: str) -> dict:
    with _pull_lock:
        return pull_states.setdefault(f"{case}/{device}", {
            "running": False, "case": case, "device": device, "serial": None, "stage": "new",
            "phase": None, "files": 0, "total_files": 0, "bytes": 0, "total_bytes": 0,
            "pct": 0, "done": False, "error": None, "log": "", "image_sha256": None, "image_name": None,
        })


def _all_states() -> dict[str, dict]:
    with _pull_lock:
        return {k: dict(v) for k, v in pull_states.items()}


def _claim(case: str, device: str, serial: str | None = None):
    """Giữ chỗ trước khi chạy luồng: bấm 2 lần không được 2 luồng ghi chung một thư mục / kéo cùng một máy."""
    st = _dev_state(case, device)
    with _pull_lock:
        if st["running"] or (serial and any(s["running"] and s["serial"] == serial for s in pull_states.values())):
            raise HTTPException(409, "thiết bị đang chạy, chờ xong")
        st["running"] = True


class ImageReq(BaseModel):
    case: str
    device: str | None = None


class PullReq(BaseModel):
    case: str
    device: str
    serial: str | None = None


def _adb_devices() -> list[dict]:
    """Liệt kê thiết bị adb đang cắm + trạng thái (device/unauthorized/offline...). Dùng cho cảnh báo lỗi chủ động."""
    try:
        out = subprocess.run([ADB, "devices"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return []
    devs = []
    for line in out.splitlines()[1:]:
        parts = line.split()
        if len(parts) >= 2 and parts[0] and parts[1].strip():
            devs.append({"serial": parts[0], "state": parts[1].strip()})
    return devs


def _adb_phone() -> str | None:
    """Serial của điện thoại đầu tiên đã cho phép gỡ lỗi (state 'device')."""
    try:
        out = subprocess.run([ADB, "devices"], capture_output=True, text=True, timeout=10).stdout
    except (OSError, subprocess.SubprocessError):
        return None
    for line in out.splitlines()[1:]:
        p = line.split()
        if len(p) >= 2 and p[1] == "device":
            return p[0]
    return None


_SIM_KEYS = ("gsm.sim.state", "gsm.sim.operator.alpha", "gsm.sim.operator.numeric", "gsm.sim.sim_series",
             "gsm.sim.iccidi", "gsm.sim.icc_id", "gsm.sim.phone", "gsm.sim.imei", "gsm.sim.meid",
             "gsm.version.baseband", "gsm.operator.alpha", "persist.sys.oplus.simlockoperator", "sys.carrier_id1")


def _sim_props(serial: str) -> dict[str, str]:
    """Đọc thông tin SIM/IMEI qua getprop (không cần root). ICCID/số máy có thể trống: máy mới giấu."""
    try:
        out = subprocess.run([ADB, "-s", serial, "shell", "getprop"],
                             capture_output=True, text=True, timeout=20).stdout
    except (OSError, subprocess.SubprocessError):
        return {}
    props: dict[str, str] = {}
    for line in out.splitlines():
        if "]: [" not in line:
            continue
        k, _, v = line.partition("]: [")
        k = k.lstrip("[").strip()
        v = v.rstrip("]").strip()
        if k in _SIM_KEYS and v and v != "ABSENT":
            props[k] = v
    return props


def _tree(p: Path) -> tuple[int, int]:
    """(số file, tổng byte) trong thư mục; đo lại liên tục để tính % khi adb đang ghi."""
    n = s = 0
    for root, _, fs in os.walk(p):
        for f in fs:
            try:
                s += os.lstat(os.path.join(root, f)).st_size
                n += 1
            except OSError:
                pass
    return n, s


def _adb_shell(serial: str, cmd: str, timeout: int = 60) -> str:
    """Chạy lệnh adb shell, trả stdout (rỗng nếu lỗi). Không root, không xóa gì."""
    try:
        r = subprocess.run([ADB, "-s", serial, "shell", cmd],
                           capture_output=True, text=True, timeout=timeout)
        return r.stdout or ""
    except (OSError, subprocess.SubprocessError):
        return ""


def _androidqf_collect(serial: str, dest: Path):
    """Thu thập dữ liệu hệ thống phong phú như AndroidQF: getprop đầy đủ, settings,
    danh sách gói, service/process, logcat, bugreport và bảng kê file kèm checksum.
    Không cần root, không xóa dữ liệu trên máy."""
    meta = dest / "_aqf"
    meta.mkdir(exist_ok=True)
    # 1) Toàn bộ system properties (SIM, IMEI, build, kernel...) -> như getprop.txt của AndroidQF
    _write(meta / "getprop.txt", _adb_shell(serial, "getprop"))
    # 2) Cấu hình settings — 3 bảng
    for table in ("global", "secure", "system"):
        _write(meta / f"settings_{table}.txt", _adb_shell(serial, f"settings list {table}"))
    # 3) Danh sách gói đã cài + app thứ ba
    _write(meta / "packages.txt", _adb_shell(serial, "pm list packages -f"))
    # 4) Service & process đang chạy
    _write(meta / "services.txt", _adb_shell(serial, "dumpsys activity services", 120))
    _write(meta / "processes.txt", _adb_shell(serial, "ps -A -o USER,PID,PPID,NAME"))
    # 5) logcat — 2000 dòng cuối (tránh file quá lớn)
    _write(meta / "logcat.txt", _adb_shell(serial, "logcat -d -t 2000", 120))
    # 6) dumpsys tổng thể (battery, wifi, bluetooth, telephony...)
    _write(meta / "dumpsys.txt", _adb_shell(serial, "dumpsys", 180))
    # 7) Bugreport nếu thiết bị cho phép (zip lớn; bỏ qua khi lỗi)
    try:
        subprocess.run([ADB, "-s", serial, "bugreport", str(meta / "bugreport.zip")],
                       capture_output=True, timeout=300)
    except (OSError, subprocess.SubprocessError):
        pass
    # 8) files.json — bảng kê toàn bộ file /sdcard kèm checksum (giống AndroidQF, non-root)
    try:
        # 2000 file đầu (đủ cho bảng kê), hash ngay trên máy bằng MỘT lệnh (xargs) thay vì 2000 lệnh adb riêng lẻ
        out = _adb_shell(serial, "find /sdcard/ -type f 2>/dev/null | head -n 2000 | tr '\\n' '\\0' | xargs -0 sha1sum 2>/dev/null", 300)
        rows = []
        for line in out.splitlines():
            h, _, path = line.partition("  ")
            if path.strip():
                rows.append({"path": path.strip(), "sha1": h if len(h) == 40 else None})
        (meta / "files.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 - bảng kê là tùy chọn
        pass
    # 9) Danh bạ (thông tin bạn bè) — content provider, không root, đa số máy cho đọc
    _write(meta / "contacts.txt", _adb_shell(serial, "content query --uri content://contacts/phones --projection display_name:number"))
    # 10) Nhật ký cuộc gọi — một số máy chặn, bọc ngoại lệ
    _write(meta / "call_log.txt", _adb_shell(serial, "content query --uri content://call_log/calls --projection date:number:type:duration:name --sort 'date DESC'"))
    # 11) Thông báo hiện tại (tin nhắn Zalo/FB mới nhất, OTP...) — nguồn tin nhắn không-root
    _write(meta / "notifications.txt", _adb_shell(serial, "dumpsys notification --noredact 2>/dev/null || dumpsys notification", 120))
    # 12) SMS — chỉ đọc; Android mới có thể trả "Permission Denial" (vẫn ghi lại làm biên bản)
    _write(meta / "sms.txt", _adb_shell(serial, "content query --uri content://sms --projection address:date:type:read:body --sort 'date DESC'", 120))
    # 13) APK của app bên thứ ba — chỉ sao chép, không gỡ app
    # shortcut: chỉ base.apk, bỏ split APK; thêm split nếu cần cài lại app để phân tích
    apk = meta / "apk"
    apk.mkdir(exist_ok=True)
    for line in _adb_shell(serial, "pm list packages -f -3").splitlines():
        path, _, pkg = line.strip().removeprefix("package:").rpartition("=")
        if path.endswith(".apk") and re.fullmatch(r"[\w.]+", pkg):
            try:
                subprocess.run([ADB, "-s", serial, "pull", path, str(apk / f"{pkg}.apk")], capture_output=True, timeout=300)
            except (OSError, subprocess.SubprocessError):
                pass


def _write(p: Path, text: str):
    if text.strip():
        p.write_text(text, encoding="utf-8")


def _is_ios(serial: str) -> bool:
    """Thiết bị có phải iPhone/iPad (có trong idevice_id - libimobiledevice)."""
    try:
        out = subprocess.run(["idevice_id", "-l"], capture_output=True, text=True, timeout=15).stdout
    except (OSError, subprocess.SubprocessError):
        return False
    tgt = serial.upper().replace("-", "")
    return any(tgt in s.upper().replace("-", "") for s in out.split())


def _parse_estimate(ios: bool, out: str) -> dict:
    """iPhone: dung lượng đã dùng từ com.apple.disk_usage; Android: du -sk + số file của /sdcard."""
    if ios:
        kv = dict(l.split(": ", 1) for l in out.splitlines() if ": " in l)
        cap, free = kv.get("TotalDataCapacity", ""), kv.get("TotalDataAvailable", "")
        return {"bytes": int(cap) - int(free) if cap.isdigit() and free.isdigit() else 0, "files": None}
    w = out.split()
    return {"bytes": int(w[0]) << 10 if w and w[0].isdigit() else 0,
            "files": int(w[-1]) if len(w) > 1 and w[-1].isdigit() else None}


_est_cache: dict = {}  # shortcut: theo serial, không hết hạn; dữ liệu máy đổi nhiều thì thêm TTL


def _adb_ready(serial: str) -> str | None:
    """Vì sao adb chưa đọc được máy này (None = sẵn sàng). Máy cắm ở chế độ sạc/MTP không hiện trong adb devices."""
    st = {x["serial"].lower(): x["state"] for x in _adb_devices()}.get(serial.lower())
    if st == "device":
        return None
    if st is None:
        return "Chưa bật Gỡ lỗi USB trên máy (Cài đặt → Tuỳ chọn nhà phát triển → Gỡ lỗi USB), rồi cắm lại cáp"
    if st == "unauthorized":
        return "Mở khoá máy và bấm Cho phép gỡ lỗi USB trên màn hình máy"
    if st == "offline":
        return "Máy offline: rút cáp cắm lại, hoặc tắt/bật Gỡ lỗi USB"
    return f"adb: {st}"


@app.get("/api/device/estimate")
def device_estimate(serial: str):
    """Dự kiến dữ liệu lấy được từ máy đang cắm, trước khi đóng image."""
    if serial in _est_cache:
        return _est_cache[serial]
    ios = _is_ios(serial)
    if not ios:
        why = _adb_ready(serial)
        if why:
            raise HTTPException(503, why)
    try:
        cmd = (["ideviceinfo", "-q", "com.apple.disk_usage"] if ios else
               [ADB, "-s", serial, "shell", "du -sk /sdcard/ 2>/dev/null; find /sdcard/ -type f 2>/dev/null | wc -l"])
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=600)
    except (OSError, subprocess.SubprocessError) as e:
        raise HTTPException(503, _short_err(str(e)))
    if r.returncode:
        raise HTTPException(503, _short_err(r.stderr or r.stdout))
    est = _parse_estimate(ios, r.stdout)
    if est["bytes"]:
        _est_cache[serial] = est
    return est


def _short_err(e: str) -> str:
    """Lỗi adb/idevice thô -> câu ngắn cho người dùng; lỗi lạ giữ nguyên."""
    low = e.lower()
    if "unauthorized" in low:
        return "Chưa cho phép gỡ lỗi USB trên thiết bị"
    if any(k in low for k in ("not found", "offline", "no devices", "no device", "device not", "closed")):
        return "Không kết nối được thiết bị"
    return e[:300]


_REIMAGED: set = set()


def _ios_fresh(dest: Path) -> None:
    """Cắm lại máy: backup cũ (chưa mã hoá) chuyển sang DATA/.old (giữ làm chứng cứ, không index),
    xoá cây tên thật để dựng lại từ backup mới; _extract_worker dọn index của các thư mục này."""
    bd = dest / "_ios_backup"
    if not (bd.is_dir() and any(bd.iterdir())):
        return
    old = DATA / ".old" / dest.relative_to(UPLOADS) / f"ios_backup_{time.strftime('%Y%m%d-%H%M%S')}"
    old.parent.mkdir(parents=True, exist_ok=True)
    shutil.move(str(bd), str(old))
    for d in ("_ios_files", "_chat", "_records", "_ios_crash"):
        p = dest / d
        if p.exists():
            shutil.rmtree(p)
    _REIMAGED.add(str(dest))
    print(f"backup cũ -> {old}")


def _idb(serial: str, *args: str, timeout: int = 180) -> subprocess.CompletedProcess:
    return subprocess.run(["idevicebackup2", "-u", serial, *args], capture_output=True, text=True, timeout=timeout)


def _ios_collect(serial: str, dest: Path, st: dict, sess_id=None) -> tuple[int, int]:
    """iPhone: iTunes backup đầy đủ qua idevicebackup2 (không jailbreak, không xoá gì trên máy).
    Bật mã hoá backup tạm thời để có thêm Keychain/Safari/Health, backup xong tắt lại; mật khẩu ghi vào biên bản phiên.
    Kèm crash report (-k: giữ nguyên bản trên máy)."""
    _ios_fresh(dest)
    bd = dest / "_ios_backup"
    bd.mkdir(parents=True, exist_ok=True)
    pw = None
    will = subprocess.run(["ideviceinfo", "-u", serial, "-q", "com.apple.mobile.backup", "-k", "WillEncrypt"],
                          capture_output=True, text=True, timeout=30).stdout.strip()
    if will == "true":
        st.update(log="Máy đã có mật khẩu backup của chủ máy: backup sẽ mã hoá bằng mật khẩu đó, cần hỏi chủ máy để giải mã")
    else:
        pw = secrets.token_urlsafe(12)
        if sess_id is not None:  # ghi trước khi bật: lỡ treo giữa chừng vẫn còn mật khẩu để tắt
            db.sessions.update_one({"id": sess_id}, {"$set": {"backup_password": pw, "backup_encryption": "on"}})
        st.update(phase="pull", log="Bật mã hoá backup tạm thời — nhập mật mã khoá màn hình trên iPhone nếu máy hỏi…")
        if _idb(serial, "encryption", "on", pw, str(bd)).returncode:
            pw = None
            if sess_id is not None:
                db.sessions.update_one({"id": sess_id}, {"$set": {"backup_password": None, "backup_encryption": "failed"}})
    try:
        st.update(phase="pull", log="Đang backup iPhone (giữ màn hình mở khoá, đã tin tưởng máy này)…", pct=0, files=0, bytes=0)
        r = subprocess.run(["idevicebackup2", "backup", "--full", str(bd)],
                           capture_output=True, text=True, timeout=9000)
        tail = " ".join((r.stdout or "").strip().splitlines()[-12:]) or (r.stderr or "")[:200]
        if r.returncode:
            raise RuntimeError(f"idevicebackup2 lỗi ({r.returncode}): {tail}")
    finally:
        if pw:  # trả máy về như cũ
            off = _idb(serial, "encryption", "off", pw, str(bd))
            if sess_id is not None:
                db.sessions.update_one({"id": sess_id}, {"$set": {"backup_encryption": "still_on" if off.returncode else "off"}})
    try:
        info = subprocess.run(["ideviceinfo"], capture_output=True, text=True, timeout=30).stdout
        if info:
            (dest / "_ios_info.txt").write_text(info, encoding="utf-8")
        st.update(log="Đang lấy crash report (giữ nguyên trên máy)…")
        (dest / "_ios_crash").mkdir(exist_ok=True)
        subprocess.run(["idevicecrashreport", "-u", serial, "-k", str(dest / "_ios_crash")], capture_output=True, timeout=600)
    except (OSError, subprocess.SubprocessError):
        pass
    n, s = _tree(dest)
    st.update(phase="pull", files=n, bytes=s, pct=100, log=f"iPhone backup xong: {n} file, {s} bytes")
    return n, s


def _nska(raw: bytes) -> dict:
    """Giải NSKeyedArchiver (plist Zalo lưu bạn bè/nhóm) -> dict khoá -> giá trị chuỗi/số."""
    d = plistlib.loads(raw)
    objs = d["$objects"]
    root = objs[d["$top"]["root"].data]
    return {k: objs[v.data] if isinstance(v, plistlib.UID) else v for k, v in root.items() if k != "$class"}


_ZALO_TYPE = {3: "[Ảnh]", 4: "[Ảnh]", 6: "[Tin nhắn thoại]", 10: "[Sticker]", 12: "[Liên kết]", 18: "[Vị trí]",
              19: "[Video]", 22: "[Tệp]", 32: "[Danh thiếp]", 33: "[Danh thiếp]"}
_ZALO_PART = 45000  # < indexer.MAX_TEXT: mỗi phần hiện đủ trên trang vụ án; tìm kiếm vẫn trên toàn bộ chunk


def _zalo_export(dest: Path) -> int:
    """Zalo iOS (backup có chat_dbs/<tài khoản>/<cuộc chat>.db, bảng ChatContent): xuất mỗi cuộc chat ra
    _chat/zalo/zalo_<tên>.txt dạng 'thời gian | người gửi | cuộc chat | nội dung' để index + hiện thành hội thoại.
    Chỉ đọc (mode=ro) trên bản sao trong _ios_files. Trả số tin nhắn."""
    z = dest / "_ios_files" / "AppDomain-vn.com.vng.zingalo" / "Documents" / "chat_dbs"
    if not z.is_dir():
        return 0
    names: dict[str, str] = {}  # id bạn bè / nhóm -> tên
    for g in ("zfriends", "zgroups"):
        for p in (dest / "_ios_files").glob(f"AppDomainGroup-group.{g}.vn.com.vng.zingalo/Library/Preferences/*.plist"):
            for k, v in plistlib.loads(p.read_bytes()).items():
                try:
                    o = _nska(v) if isinstance(v, bytes) else {}
                except Exception:  # noqa: BLE001 - mục hỏng: bỏ qua, dùng ID
                    continue
                nid = str(o.get("zaloId") or o.get("zaloid") or o.get("groupid") or k.rsplit("_", 1)[-1])
                nm = o.get("contactName") or o.get("displayName") or o.get("groupName") or o.get("aliasname")
                if isinstance(nm, str) and nm.strip():
                    names[nid] = nm.strip()
    out = dest / "_chat" / "zalo"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    total = 0
    for dbp in sorted(z.glob("*/*.db")):
        me, tid = dbp.parent.name, dbp.stem
        grp = tid.startswith("group_")
        rid = tid.removeprefix("group_")
        title = names.get(rid) or (f"Nhóm {rid}" if grp else f"ID {rid}")
        try:
            c = sqlite3.connect(f"file:{dbp}?mode=ro", uri=True)
            rows = c.execute("SELECT SenderId, TimeStamp, MsgType, MsgContent, BinNet, LocalPath FROM ChatContent ORDER BY TimeStamp").fetchall()
            c.close()
        except sqlite3.Error:
            continue
        media: dict[str, str] = {}  # tên tệp không đuôi -> đường dẫn, trong thư mục tệp của cuộc chat
        for d in {z.parent / me / rid, z.parent / me / tid}:
            for p in d.rglob("*") if d.is_dir() else ():
                if p.is_file():
                    media.setdefault(p.name.split(".")[0], str(p))
        lines = []
        for sender, ts, mt, text, bn, lp in rows:
            who = "Chủ máy" if str(sender) == me else names.get(str(sender), f"ID {sender}")
            t = time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime((ts or 0) / 1000 + 7 * 3600))  # giờ Việt Nam
            body = (text or "").strip()
            if mt != 0 or not body:
                label = _ZALO_TYPE.get(mt, "")
                if mt == 18 and bn:
                    m = re.search(rb'"latitude":([-\d.]+),"longitude":([-\d.]+)', bn)
                    label += f" {float(m[1]):.6f}, {float(m[2]):.6f}" if m else ""
                body = f"{label} {body}".strip() or f"[Loại tin {mt}]"
                hit = next((media[t.decode()] for t in re.findall(rb"1[0-9A-Z]{8}_[0-9A-Z]{6}", bn or b"") if t.decode() in media),
                           media.get(Path(lp).name.split(".")[0]) if lp else None)
                if hit:
                    body += f" ⟦{hit}⟧"
            lines.append(f"{t} | {who} | {title} | {' '.join(body.split())}")
        if not lines:
            continue
        total += len(lines)
        safe = re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", title)[:60]
        parts, cur, size = [], [], 0
        for ln in lines:
            if cur and size + len(ln) > _ZALO_PART:
                parts.append(cur)
                cur, size = [], 0
            cur.append(ln)
            size += len(ln) + 1
        parts.append(cur)
        for i, part in enumerate(parts, 1):
            suf = f"_p{i}" if len(parts) > 1 else ""
            (out / f"zalo_{safe}_{me}_{tid}{suf}.txt").write_text(
                "Thời gian | Từ | Tới | Nội dung\n" + "\n".join(part) + "\n", encoding="utf-8")
    return total


# ---- Bộ đọc CSDL app/hệ thống -> tệp văn bản trong _chat/<app>/ (hội thoại) và _records/ (danh bạ, cuộc gọi, ghi chú).
# Cùng định dạng 'Thời gian | Từ | Tới | Nội dung' như _zalo_export để trang vụ án hiện thành khung chat.
_APPLE_EPOCH = 978307200  # 2001-01-01 UTC


def _vn(ts: float) -> str:
    return time.strftime("%Y-%m-%d %H:%M:%S", time.gmtime(ts + 7 * 3600))


def _ro(p: Path):
    return sqlite3.connect(f"file:{p}?mode=ro", uri=True)


def _safe(s: str) -> str:
    return re.sub(r'[\\/:*?"<>|\x00-\x1f]', "_", s)[:60]


def _write_parts(stem: Path, header: str, lines: list) -> None:
    """Ghi stem.txt, quá ~45.000 ký tự thì stem_p1.txt, stem_p2.txt… (index chỉ giữ 50.000 ký tự mỗi tệp)."""
    parts, cur, size = [], [], 0
    for ln in lines:
        if cur and size + len(ln) > _ZALO_PART:
            parts.append(cur)
            cur, size = [], 0
        cur.append(ln)
        size += len(ln) + 1
    parts.append(cur)
    for i, part in enumerate(parts, 1):
        (stem.parent / f"{stem.name}{f'_p{i}' if len(parts) > 1 else ''}.txt").write_text(
            header + "\n" + "\n".join(part) + "\n", encoding="utf-8")


def _write_threads(out: Path, app: str, threads: dict) -> int:
    """threads: {(khoá, tiêu đề): [(ts, người gửi, nội dung)]} -> mỗi hội thoại 1+ tệp."""
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    total = 0
    for (key, title), msgs in threads.items():
        lines = [f"{_vn(ts)} | {who} | {title} | {' '.join(str(body).split())}" for ts, who, body in sorted(msgs, key=lambda m: m[0])]
        if lines:
            total += len(lines)
            _write_parts(out / f"{app}_{_safe(title)}_{_safe(str(key))}", "Thời gian | Từ | Tới | Nội dung", lines)
    return total


def _attr_text(blob: bytes | None) -> str:
    """iMessage iOS 16+: chữ nằm trong attributedBody (typedstream) khi cột text rỗng."""
    if not blob:
        return ""
    i = blob.find(b"NSString")
    if i < 0:
        return ""
    j = blob.find(b"+", i)
    if j < 0:
        return ""
    n, k = blob[j + 1], j + 2
    if n == 0x81:
        n, k = int.from_bytes(blob[k:k + 2], "little"), k + 2
    return blob[k:k + n].decode("utf-8", "replace")


def _imessage_export(dest: Path) -> int:
    db = dest / "_ios_files/HomeDomain/Library/SMS/sms.db"
    if not db.is_file():
        return 0
    c = _ro(db)
    names = {}
    ab = dest / "_ios_files/HomeDomain/Library/AddressBook/AddressBook.sqlitedb"
    if ab.is_file():
        a = _ro(ab)
        for first, last, org, num in a.execute(
                "SELECT p.First, p.Last, p.Organization, v.value FROM ABPerson p JOIN ABMultiValue v ON v.record_id = p.ROWID WHERE v.property = 3"):
            nm = " ".join(x for x in (last, first) if x) or org
            if nm and num:
                names[re.sub(r"\D", "", num)[-9:]] = nm
        a.close()

    def who(h):
        return names.get(re.sub(r"\D", "", h or "")[-9:], h) if re.search(r"\d{6}", h or "") else (h or "?")
    threads: dict = {}
    for cid, ident, disp, svc, mdate, mine, handle, text, body, att in c.execute("""
            SELECT ch.ROWID, ch.chat_identifier, ch.display_name, ch.service_name, m.date, m.is_from_me, h.id, m.text,
                   m.attributedBody, m.cache_has_attachments
            FROM message m JOIN chat_message_join j ON j.message_id = m.ROWID JOIN chat ch ON ch.ROWID = j.chat_id
            LEFT JOIN handle h ON h.ROWID = m.handle_id WHERE m.associated_message_type = 0"""):
        ts = (mdate / 1e9 if mdate > 1e12 else mdate) + _APPLE_EPOCH
        body = (text or _attr_text(body) or "").replace("￼", "").strip() or ("[Tệp đính kèm]" if att else "[Tin trống]")
        title = disp or who(ident)
        threads.setdefault((f"{svc}_{cid}", f"{title}"), []).append((ts, "Chủ máy" if mine else who(handle), body))
    c.close()
    return _write_threads(dest / "_chat/imessage", "imessage", threads)


def _whatsapp_export(dest: Path) -> int:
    base = dest / "_ios_files/AppDomainGroup-group.net.whatsapp.WhatsApp.shared"
    if not (base / "ChatStorage.sqlite").is_file():
        return 0
    c = _ro(base / "ChatStorage.sqlite")
    push = dict(c.execute("SELECT ZJID, ZPUSHNAME FROM ZWAPROFILEPUSHNAME"))
    members = {pk: (nm or push.get(jid) or jid) for pk, nm, jid in c.execute("SELECT Z_PK, ZCONTACTNAME, ZMEMBERJID FROM ZWAGROUPMEMBER")}
    kinds = {1: "[Ảnh]", 2: "[Video]", 3: "[Tin nhắn thoại]", 4: "[Danh thiếp]", 5: "[Vị trí]", 7: "[Liên kết]", 8: "[Tệp]", 15: "[Sticker]"}
    threads: dict = {}
    for sid, partner, jid, mdate, mine, mt, text, member, fromjid, path in c.execute("""
            SELECT s.Z_PK, s.ZPARTNERNAME, s.ZCONTACTJID, m.ZMESSAGEDATE, m.ZISFROMME, m.ZMESSAGETYPE, m.ZTEXT,
                   m.ZGROUPMEMBER, m.ZFROMJID, mi.ZMEDIALOCALPATH
            FROM ZWAMESSAGE m JOIN ZWACHATSESSION s ON s.Z_PK = m.ZCHATSESSION LEFT JOIN ZWAMEDIAITEM mi ON mi.Z_PK = m.ZMEDIAITEM"""):
        if mt in (6, 10) and not text:  # sự kiện nhóm / hệ thống không có chữ
            continue
        sender = "Chủ máy" if mine else members.get(member) or push.get(fromjid) or partner or fromjid or "?"
        body = (f"{kinds.get(mt, '')} {text or ''}".strip()) or f"[Loại tin {mt}]"
        if path and (base / "Message" / path).is_file():
            body += f" ⟦{base / 'Message' / path}⟧"
        threads.setdefault((sid, partner or jid or str(sid)), []).append(((mdate or 0) + _APPLE_EPOCH, sender, body))
    c.close()
    return _write_threads(dest / "_chat/whatsapp", "whatsapp", threads)


_WX_TYPE = {1: "", 3: "[Ảnh]", 34: "[Tin nhắn thoại]", 43: "[Video]", 47: "[Sticker]", 49: "[Chia sẻ]",
            10000: "", 10002: "[Thông báo]"}


def _unzstd(blob) -> str:
    """WeChat iOS nén nội dung tin ảnh/video/link/sticker bằng zstd (28 b5 2f fd). Trả đoạn chữ đọc được dài nhất."""
    if isinstance(blob, str):
        return blob
    b = bytes(blob or b"")
    if b[:4] == b"\x28\xb5\x2f\xfd":
        try:
            import zstandard
            b = zstandard.ZstdDecompressor().decompress(b, max_output_size=1 << 20)
        except Exception:  # noqa: BLE001 - WeChat nén bằng từ điển riêng nằm trong app, backup không có
            return "[Nội dung nén, cần từ điển WeChat]"
    txt = b.decode("utf-8", "replace")
    runs = re.findall(r"[^\x00-\x08\x0e-\x1f�]{3,}", txt)  # bỏ rác nhị phân, giữ đoạn chữ
    return max(runs, key=len).strip() if runs else ""


def _wechat_export(dest: Path) -> int:
    """WeChat iOS: Documents/<tài khoản>/DB/message_*.sqlite, mỗi cuộc chat một bảng Chat_<mã>.
    Chữ, ảnh/video/sticker/link (giải nén zstd), tin thoại (.aud) — chỉ đọc."""
    base = next(iter((dest / "_ios_files").glob("AppDomain-com.tencent.xin/Documents/*/DB")), None)
    if base is None or not list(base.glob("message_*.sqlite")):
        return 0
    names = {}
    wc = base / "WCDB_Contact.sqlite"
    if wc.is_file() and wc.read_bytes()[:16] == b"SQLite format 3\x00":
        c = _ro(wc)
        cols = [x[1] for x in c.execute("pragma table_info(Friend)")]
        keep = [x for x in ("userName", "dbContactRemark", "dbContactProfile") if x in cols]
        if keep and keep[0] == "userName":
            for row in c.execute(f"SELECT {', '.join(keep)} FROM Friend"):
                nm = next((_unzstd(v) for v in row[1:] if v), "")
                if nm:
                    names[str(row[0])] = names[hashlib.md5(str(row[0]).encode()).hexdigest()] = nm[:60]  # bảng Chat_<md5(userName)>
        c.close()
    threads: dict = {}
    for dbp in sorted(base.glob("message_*.sqlite")):
        with dbp.open("rb") as fh:
            if fh.read(16) != b"SQLite format 3\x00":
                continue
        c = _ro(dbp)
        tabs = [t for (t,) in c.execute("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Chat%' AND name NOT LIKE 'ChatExt%'")]
        for t in tabs:
            h = t.removeprefix("Chat_")
            title = names.get(h) or f"WeChat {h[:8]}"
            for ctime, des, mtype, msg, mid in c.execute(f'SELECT CreateTime, Des, Type, Message, MesLocalID FROM "{t}" ORDER BY CreateTime'):
                body = (msg or "").strip() if isinstance(msg, str) else _unzstd(msg)
                label = _WX_TYPE.get(mtype, f"[Loại tin {mtype}]")
                if mtype == 34:  # thoại: tệp .aud trong Audio/<md5 cuộc chat>/<MesLocalID>.aud
                    aud = base.parent / "Audio" / h / f"{mid}.aud"
                    label += f" ⟦{aud}⟧" if aud.is_file() else ""
                who = "Chủ máy" if des == 0 else title  # WeChat iOS: Des 0 = mình gửi, 1 = nhận
                if des == 1 and (m := re.match(r"^([\w-]+):\n", body)):  # nhóm: "wxid_x:\nnội dung"
                    who, body = names.get(m[1], m[1]), body[m.end():]
                body = f"{label} {body}".strip() or f"[Loại tin {mtype}]"
                threads.setdefault((h, title), []).append((ctime or 0, who, body))
        c.close()
    return _write_threads(dest / "_chat/wechat", "wechat", threads)


def _records_export(dest: Path) -> int:
    """Danh bạ (iOS AddressBook / Android contacts.txt), cuộc gọi (Android call_log.txt), ghi chú (iOS Notes)
    -> _records/danh_ba.txt, cuoc_goi.txt, ghi_chu/*.txt (định dạng mà trang vụ án đã đọc được)."""
    out = dest / "_records"
    if out.exists():
        shutil.rmtree(out)
    out.mkdir()
    n = 0
    rows = []
    ab = dest / "_ios_files/HomeDomain/Library/AddressBook/AddressBook.sqlitedb"
    if ab.is_file():
        a = _ro(ab)
        people: dict = {}
        for pid, first, last, org, prop, val in a.execute(
                "SELECT p.ROWID, p.First, p.Last, p.Organization, v.property, v.value FROM ABPerson p "
                "LEFT JOIN ABMultiValue v ON v.record_id = p.ROWID"):
            e = people.setdefault(pid, [" ".join(x for x in (last, first) if x) or org or "?", [], []])
            if prop == 3 and val:
                e[1].append(val)
            elif prop == 4 and val:
                e[2].append(val)
        a.close()
        rows += [f"{nm} | {', '.join(ph)} | {', '.join(em)}" for nm, ph, em in people.values()]
    aqf = dest / "_aqf/contacts.txt"
    if aqf.is_file():
        for m in re.finditer(r"display_name=(.*?), number=(.*)", aqf.read_text(errors="replace")):
            rows.append(f"{m[1].strip()} | {m[2].strip()} | ")
    if rows:
        _write_parts(out / "danh_ba", "Tên | Số điện thoại | Email", rows)
        n += len(rows)
    calls = []
    cl = dest / "_aqf/call_log.txt"
    if cl.is_file():
        kind = {"1": "gọi đến", "2": "gọi đi", "3": "nhỡ", "4": "thư thoại", "5": "từ chối", "6": "chặn"}
        for m in re.finditer(r"date=(\d+), number=(.*?), type=(\d+), duration=(\d+), name=(.*)", cl.read_text(errors="replace")):
            nm = m[5].strip()
            who_ = f"{nm} ({m[2]})" if nm and nm != "NULL" else m[2]
            calls.append(f"{_vn(int(m[1]) / 1000)} | {who_} | {kind.get(m[3], m[3])} | {m[4]}")
    if calls:
        _write_parts(out / "cuoc_goi", "Thời gian | Số | Hướng | Thời lượng", calls)
        n += len(calls)
    ns = dest / "_ios_files/AppDomainGroup-group.com.apple.notes/NoteStore.sqlite"
    if ns.is_file():
        import gzip
        c = _ro(ns)
        (out / "ghi_chu").mkdir()
        for pk, title, mod, data in c.execute(
                "SELECT o.Z_PK, o.ZTITLE1, o.ZMODIFICATIONDATE1, d.ZDATA FROM ZICCLOUDSYNCINGOBJECT o "
                "JOIN ZICNOTEDATA d ON d.ZNOTE = o.Z_PK WHERE d.ZDATA IS NOT NULL AND COALESCE(o.ZISPASSWORDPROTECTED, 0) = 0"):
            try:
                raw = gzip.decompress(data) if data[:2] == b"\x1f\x8b" else data
            except OSError:
                continue
            # protobuf Note: lấy đoạn chữ UTF-8 dài nhất trong bản ghi là đủ để đọc + tìm kiếm
            txt = max(re.findall(rb"[^\x00-\x08\x0e-\x1f]{2,}", raw), key=len, default=b"").decode("utf-8", "replace")
            (out / "ghi_chu" / f"ghi_chu_{pk}_{_safe(title or 'Không tên')}.txt").write_text(
                f"{title or ''}\nSửa lần cuối: {_vn((mod or 0) + _APPLE_EPOCH)}\n\n{txt.strip()}\n", encoding="utf-8")
            n += 1
        c.close()
    return n


def _ios_files(dest: Path, case: str, device: str) -> int:
    """Backup iPhone lưu file theo hash: dựng lại cây _ios_files/<domain>/<relativePath> để index có tên thật.
    Backup thường -> hardlink (không tốn chỗ, giữ mtime); backup mã hoá -> giải mã bằng mật khẩu trong biên bản phiên."""
    out, n = dest / "_ios_files", 0
    for man in (dest / "_ios_backup").glob("*/Manifest.db"):
        root = man.parent
        if plistlib.loads((root / "Manifest.plist").read_bytes()).get("IsEncrypted"):
            sess = db.sessions.find_one({"case_name": case, "device": device, "backup_password": {"$ne": None}}, sort=[("id", -1)])
            if not sess:
                raise RuntimeError("Backup iPhone đã mã hoá nhưng biên bản phiên không có mật khẩu")
            from iphone_backup_decrypt import EncryptedBackup
            n += EncryptedBackup(backup_directory=str(root), passphrase=sess["backup_password"]).extract_files(
                output_folder=str(out), preserve_folders=True, domain_subfolders=True) or 0
            continue
        c = sqlite3.connect(f"file:{man}?mode=ro", uri=True)
        try:
            rows = c.execute("SELECT fileID, domain, relativePath FROM Files WHERE flags = 1").fetchall()
        finally:
            c.close()
        for fid, domain, rel in rows:
            src, rp = root / fid[:2] / fid, Path(domain or "_", rel or fid)
            if rp.is_absolute() or ".." in rp.parts or not src.is_file():
                continue
            tgt = out / rp
            try:
                tgt.parent.mkdir(parents=True, exist_ok=True)
                if not tgt.exists():
                    try:
                        os.link(src, tgt)
                    except OSError:
                        shutil.copy2(src, tgt)
                n += 1
            except OSError:  # trùng tên file/thư mục trong cây gốc: bỏ file đó, bản hash vẫn còn trong _ios_backup
                pass
    return n


def _acquire_worker(serial: str, case: str, device: str, dest: Path):
    """ĐÓNG IMAGE: kéo dữ liệu thô + thu thập hệ thống (androidqf), rồi đóng gói tar.gz kèm manifest SHA256.
    Xong -> stage 'imaged'. (Chưa index; index là bước Trích xuất riêng.)"""
    st = _dev_state(case, device)
    st.update(running=True, serial=serial, stage="imaging", phase="count", files=0, total_files=0, bytes=0,
              total_bytes=0, pct=0, done=False, error=None, log="Đang đếm dữ liệu trên máy…")
    sess_id = None
    try:
        dest.mkdir(parents=True, exist_ok=True)
        sess_id = next_id("sessions")
        db.sessions.insert_one({"id": sess_id, "case_name": case, "device": device, "operator": None, "started_at": indexer.now(),
                                "finished_at": None, "files": 0, "bytes": 0, "status": "running", "error": None})
        if _is_ios(serial):
            n, s = _ios_collect(serial, dest, st, sess_id)
        else:
            sim = _sim_props(serial)
            if sim:
                (dest / "sim.txt").write_text("\n".join(f"{k} = {v}" for k, v in sim.items()) + "\n", encoding="utf-8")
            # tổng trên máy: du (KB) + số file; thư mục bị chặn quyền (Android/data) bị bỏ qua ở cả hai phía
            out = subprocess.run([ADB, "-s", serial, "shell", "du -sk /sdcard/ 2>/dev/null; find /sdcard/ -type f 2>/dev/null | wc -l"],
                                 capture_output=True, text=True, timeout=600).stdout.split()
            total = int(out[0]) << 10 if out and out[0].isdigit() else 0
            st.update(phase="pull", total_bytes=total, total_files=int(out[-1]) if out and out[-1].isdigit() else 0,
                      log="Đang kéo dữ liệu…")
            base_n, base_s = _tree(dest)  # kéo lại vào thư mục có sẵn file: chỉ tính phần mới
            log = DATA / f"pull-{serial}.log"
            n = s = 0
            aqf_err: list = []

            def aqf():  # thu thập hệ thống (getprop/dumpsys/bugreport/sha1) song song với pull: trước đây tốn thêm ~5 phút sau pull
                try:
                    _androidqf_collect(serial, dest)
                except Exception as e:  # noqa: BLE001 - thu thập phụ không được làm hỏng luồng chính
                    aqf_err.append(str(e)[:120])
            aqf_t = threading.Thread(target=aqf, daemon=True)
            aqf_t.start()
            todo, running, rcs = _pull_units(serial, dest), [], []
            with log.open("w") as lf:  # ghi ra file, không dùng pipe: nhiều dòng lỗi quyền có thể làm đầy pipe và treo adb
                while todo or running:
                    while todo and len(running) < PULL_STREAMS:
                        remote, local = todo.pop(0)
                        local.mkdir(parents=True, exist_ok=True)
                        running.append(subprocess.Popen([ADB, "-s", serial, "pull", "-a", remote, str(local)],
                                                        stdout=lf, stderr=subprocess.STDOUT))
                    time.sleep(2)
                    rcs += [p.returncode for p in running if p.poll() is not None]
                    running = [p for p in running if p.returncode is None]
                    n, s = (x - b for x, b in zip(_tree(dest), (base_n, base_s)))
                    # du tính theo block nên lệch chút với kích thước thật: giữ 99% tới khi adb xong
                    st.update(files=n, bytes=s, pct=min(99, round(100 * s / total)) if total else 0)
            n, s = (x - b for x, b in zip(_tree(dest), (base_n, base_s)))
            last = (log.read_text(errors="replace").strip().splitlines() or [""])[-1][:200]
            if any(rcs) and not n:  # mã lỗi khác 0 cũng xảy ra khi chỉ vài file bị chặn quyền: chỉ báo lỗi khi không kéo được gì
                raise RuntimeError(last or "adb pull lỗi")
            # rút cáp giữa chừng: adb lỗi nhưng đã kéo được một phần -> không đóng gói image thiếu như image đủ
            if subprocess.run([ADB, "-s", serial, "get-state"], capture_output=True, text=True, timeout=15).stdout.strip() != "device":
                raise RuntimeError("Mất kết nối với điện thoại giữa chừng (rút cáp?): cắm lại rồi đóng image lại")
            if aqf_t.is_alive():
                st.update(phase="pull", pct=100, log="Kéo xong; đang chờ thu thập dữ liệu hệ thống (bugreport)…")
                aqf_t.join(timeout=900)
            if aqf_err:
                st.update(log=f"Kéo xong; thu thập hệ thống bỏ qua: {aqf_err[0]}")
            n, s = (x - b for x, b in zip(_tree(dest), (base_n, base_s)))  # tính cả _aqf
            st.update(files=n, bytes=s, pct=100, log=last)
        # Đóng gói tar.gz + manifest SHA256 (đúng nghĩa "đóng image kèm hash")
        st.update(phase="package", pct=0, log="Đang đóng gói image (tar + SHA256)…")

        def pkg_progress(done, total):
            pct = min(100, round(100 * done / total))
            if pct != st.get("pct"):
                st.update(pct=pct, log=f"Đang đóng gói image: {done / 2**30:.1f} / {total / 2**30:.1f} GB · {pct}%")
        row_id, arc, man = packaging.create_package(case, dest, PACKAGES, pkg_progress)
        pkg = db.packages.find_one({"id": row_id})
        st.update(stage="imaged", phase=None, running=False, done=True, pct=100,
                  image_sha256=(pkg.get("sha256") if pkg else None), image_name=(pkg.get("name") if pkg else None),
                  log=f"Đã đóng image: {arc.name} ({arc.stat().st_size:,} bytes)")
        if sess_id is not None:
            db.sessions.update_one({"id": sess_id}, {"$set": {"status": "done", "bytes": s, "finished_at": indexer.now()}})
    except Exception as e:  # noqa: BLE001
        msg = _short_err(str(e))
        st.update(running=False, phase=None, stage="new", error=msg, log=f"Lỗi: {msg[:200]}")
        if sess_id is not None:
            db.sessions.update_one({"id": sess_id}, {"$set": {"status": "error", "error": str(e)[:200], "finished_at": indexer.now()}})


def _extract_worker(case: str, device: str, dest: Path):
    """TRÍCH XUẤT: lập chỉ mục dữ liệu đã kéo về -> thành bằng chứng xem được (danh bạ, cuộc gọi, file...)."""
    st = _dev_state(case, device)
    st.update(running=True, stage="extracting", phase="index", files=0, pct=0, done=False, error=None,
              log="Đang trích xuất & lập chỉ mục…")
    try:
        def progress(done, total):
            st.update(files=done, total_files=total, pct=round(100 * done / total) if total else 0,
                      log=f"Đang trích xuất {done:,}/{total:,} tệp…")
        if (dest / "_ios_backup").is_dir():
            st.update(log="Đang dựng lại tên tệp iPhone từ Manifest.db…")
            _ios_files(dest, case, device)
            st.update(log="Đang đọc tin nhắn Zalo, iMessage, WhatsApp…")
            for fn in (_zalo_export, _imessage_export, _whatsapp_export, _wechat_export):
                try:
                    fn(dest)
                except Exception as e:  # noqa: BLE001 - một bộ đọc lỗi không chặn trích xuất
                    print(f"{fn.__name__} lỗi: {e}")
            c = _rconn()  # bỏ bản index cũ theo tên hash (indexer giờ bỏ qua _ios_backup)
            like = f"{dest}/_ios_backup/%"
            c.execute("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE path LIKE ?)", (like,))
            c.execute("DELETE FROM files WHERE path LIKE ?", (like,))
            c.commit()
        if str(dest) in _REIMAGED:  # thu thập lại: bỏ index cũ của các thư mục vừa dựng lại
            _REIMAGED.discard(str(dest))
            c = _rconn()
            for d in ("_ios_files", "_chat", "_records"):
                like = f"{dest}/{d}/%"
                c.execute("DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE path LIKE ?)", (like,))
                c.execute("DELETE FROM files WHERE path LIKE ?", (like,))
            c.commit()
        try:  # danh bạ / cuộc gọi / ghi chú: cả iPhone và Android (_aqf)
            _records_export(dest)
        except Exception as e:  # noqa: BLE001
            print(f"_records_export lỗi: {e}")
        # giai đoạn 1 (không AI): hash, metadata, ảnh thu nhỏ, văn bản -> xem chứng cứ được ngay; AI chạy nền (_ai_loop)
        indexer.scan(str(dest), str(DATA), progress, case, device, ai=False)
        st.update(stage="done", phase=None, running=False, done=True, pct=100, log="Đã trích xuất xong; AI phân tích chạy nền")
        _ai_wake.set()
    except Exception as e:  # noqa: BLE001 - báo nguyên trạng cho UI
        st.update(running=False, phase=None, stage="error", error=str(e)[:300], log=f"Lỗi trích xuất: {str(e)[:200]}")


# Giai đoạn 2 của trích xuất: AI mô tả ảnh/OCR, ASR, chuyển đổi tài liệu cho tệp còn chờ (files.ai_pending = 1).
# Một luồng nền chung làm lần lượt từng máy (máy xong giai đoạn 1 trước làm trước) để các máy không chia nhau GPU.
_ai_wake = threading.Event()


def _ai_loop():
    while True:
        _ai_wake.wait(600)  # đánh thức khi có máy xong giai đoạn 1; 10 phút tự kiểm lại một lần
        _ai_wake.clear()
        try:
            retrieval.embed_pending(_rconn())  # chunk văn bản giai đoạn 1: tìm theo ngữ nghĩa được sớm
            while todo := indexer.ai_queue(_rconn()):
                case, device = todo[0]
                st = _dev_state(case, device)

                def progress(done, total, st=st):
                    st.update(phase="ai", pct=round(100 * done / total) if total else 100,
                              log=f"AI đang phân tích {done:,}/{total:,} tệp (ảnh, ghi âm, video, tài liệu scan)…")
                st.update(phase="ai", pct=0, log="AI bắt đầu phân tích…")
                if not indexer.ai_pass(str(DATA), case, device, progress):
                    break  # hàng chờ không giảm: tránh lặp vô hạn, lần đánh thức sau thử lại
                st.update(phase=None, pct=100, log="AI phân tích xong")
                retrieval.embed_pending(_rconn())
        except Exception as e:  # noqa: BLE001 - lỗi một lượt không giết luồng nền; lần đánh thức sau làm tiếp
            print(f"AI nền lỗi: {type(e).__name__}: {e}")


@app.on_event("startup")
def _start_ai_loop():
    _ai_wake.set()  # backend khởi động lại: làm tiếp phần còn chờ
    threading.Thread(target=_ai_loop, daemon=True, name="ai-loop").start()


@app.get("/api/phone/status")
def phone_status():
    """Trạng thái kết nối thiết bị ADB (cảnh báo chủ động): device sẵn sàng, unauthorized/offline = lỗi cần chú ý."""
    devs = _adb_devices()
    bad = [d for d in devs if d["state"] != "device"]
    return {"devices": devs, "bad": bad}


@app.get("/api/disk")
def block_devices():
    """Ổ đĩa vật lý máy chủ (NVMe/M.2, SATA, USB) đọc từ /sys/block. Chỉ nhận diện model/serial/dung lượng, không đọc nội dung."""
    out = []
    for b in sorted(Path("/sys/block").glob("*")):
        if b.name.startswith("loop") or b.name.startswith("ram") or b.name.startswith("fd"):
            continue
        try:
            size = int((b / "size").read_text().strip()) * 512
        except (OSError, ValueError):
            continue
        dev = b / "device"
        rd = lambda n: (lambda f: f.read_text().strip() if f else "")((dev / n) if (dev / n).exists() else None)
        transport = rd("transport") or ("usb" if "usb" in str(dev.resolve()) else ("sata" if b.name.startswith("sd") else "unknown"))
        parts = sorted(x.name for x in b.glob(f"{b.name}p*"))
        out.append({
            "name": b.name, "size": size,
            "model": rd("model").strip()[:60] or None,
            "serial": rd("serial").strip()[:40] or None,
            "transport": transport,
            "partitions": len(parts),
        })
    return {"disks": out}


@app.get("/api/phone/sim")
def phone_sim(serial: str | None = None):
    """Thông tin: SIM/IMEI của thiết bị đang cắm (qua getprop, không cần root). serial bắt buộc khi nhiều thiết bị."""
    if not serial:
        serial = _adb_phone()
    _track_phone(serial)
    if not serial:
        raise HTTPException(400, "Chưa có điện thoại nào cho phép gỡ lỗi USB. Bấm 'Cho phép' trên màn hình điện thoại rồi thử lại.")
    return {"serial": serial, "props": _sim_props(serial)}


class DeviceActionReq(BaseModel):
    case: str
    device: str
    serial: str | None = None


def _resolve_serial(serial: str | None) -> str:
    serial = serial or _adb_phone()
    if not serial:
        raise HTTPException(400, "Chưa có điện thoại nào cho phép gỡ lỗi USB. Bấm 'Cho phép' trên màn hình điện thoại rồi thử lại.")
    return serial


def _ensure_device(case: str, device: str, serial: str):
    """Thiết bị vào vụ án khi đóng image; lưu serial để nhận lại đúng máy sau khi rút cáp."""
    old = db.devices.find_one({"case_name": case, "name": device}, {"_id": 0, "serial": 1})
    if old and old.get("serial") and old["serial"] != serial:  # 2 máy cùng tên -> không ghi chung một thư mục
        raise HTTPException(409, f"tên '{device}' đã dùng cho máy khác (serial {old['serial']}) trong vụ án này")
    db.devices.update_one({"case_name": case, "name": device},
                          {"$set": {"type": "phone", "serial": serial},
                           "$setOnInsert": {"created_at": indexer.now(), "note": None}}, upsert=True)
    if not old:
        _audit(conn, "device.create", f"{case}/{device}", "phone")


def _acquire_then_extract(serial: str, case: str, device: str, dest: Path):
    _acquire_worker(serial, case, device, dest)
    if _dev_state(case, device)["stage"] == "imaged":
        _extract_worker(case, device, dest)


def _not_extracted(case: str, device: str):
    """Máy đã trích xuất (có tệp trong index) thì không đóng image / kéo lại: cắm lại chỉ để xem, không tạo image mới."""
    if _rconn().execute("SELECT 1 FROM files WHERE collection = ? AND device = ? LIMIT 1", (case, device)).fetchone():
        raise HTTPException(409, "thiết bị đã trích xuất, không trích xuất lại")


@app.post("/api/device/image")
def device_image(req: DeviceActionReq):
    """ĐÓNG IMAGE: kéo dữ liệu thô + thu thập hệ thống, rồi đóng gói tar.gz kèm manifest SHA256."""
    case, device = clean_name(req.case), clean_name(req.device)
    _not_extracted(case, device)
    serial = _resolve_serial(req.serial)
    _ensure_device(case, device, serial)
    if shutil.disk_usage(DATA).free < MIN_FREE:
        raise HTTPException(507, "ổ dữ liệu sắp đầy (< 5 GB trống)")
    dest = UPLOADS / case / device
    _claim(case, device, serial)
    threading.Thread(target=_acquire_then_extract, args=(serial, case, device, dest), daemon=True).start()
    _audit(conn, "device.image", f"{case}/{device}")
    return {"status": "started", "serial": serial}


@app.post("/api/device/extract")
def device_extract(req: DeviceActionReq):
    """TRÍCH XUẤT: lập chỉ mục dữ liệu đã kéo về -> thành bằng chứng xem được."""
    case, device = clean_name(req.case), clean_name(req.device)
    dest = UPLOADS / case / device
    if not dest.is_dir():
        raise HTTPException(400, "chưa đóng image cho thiết bị này")
    _claim(case, device)  # dữ liệu đã nằm trên máy chủ: không cần cắm máy
    threading.Thread(target=_extract_worker, args=(case, device, dest), daemon=True).start()
    _audit(conn, "device.extract", f"{case}/{device}")
    return {"status": "started"}


@app.get("/api/device/status")
def device_status():
    """Trạng thái đang/vừa chạy của TỪNG thiết bị (song song được), khóa theo vụ án/thiết bị.
    Trạng thái lâu dài (đã có image / đã trích xuất) nằm ở /api/devices, suy từ dữ liệu thật."""
    return {"items": list(_all_states().values())}


# Giữ /api/pull + /api/pull/status cho tương thích với CaseDetail cũ.
@app.post("/api/pull")
def pull_phone(req: PullReq):
    if any(s["running"] for s in _all_states().values()):
        raise HTTPException(409, "đang kéo dữ liệu, chờ xong")
    case, device = clean_name(req.case), clean_name(req.device)
    _not_extracted(case, device)
    serial = _resolve_serial(req.serial)
    _ensure_device(case, device, serial)
    if shutil.disk_usage(DATA).free < MIN_FREE:
        raise HTTPException(507, "ổ dữ liệu sắp đầy (< 5 GB trống)")
    dest = UPLOADS / case / device

    threading.Thread(target=_acquire_then_extract, args=(serial, case, device, dest), daemon=True).start()
    _audit(conn, "pull.start", f"{case}/{device}")
    return {"status": "started", "serial": serial}


@app.get("/api/pull/status")
def pull_status():
    """Tương thích cũ: trả trạng thái của thiết bị đang chạy (hoặc mới nhất)."""
    states = [s for s in _all_states().values()]
    active = next((s for s in states if s["running"]), None) or (states[-1] if states else None)
    if not active:
        return {"running": False, "device": None, "phase": None, "files": 0, "total_files": 0, "bytes": 0,
                "total_bytes": 0, "pct": 0, "done": False, "error": None, "log": ""}
    s = dict(active)
    if s["phase"] == "index":
        s["index"] = index_status()
    return s


# Thực thể lấy bằng regex (không gọi LLM): nhanh, không bịa. Mỗi liên kết giữ dòng bằng chứng (file, vị trí, câu gốc).
ENTITY_RE = {
    "phone": re.compile(r"(?<![\d.])(?:\+84|84|0)(?:[ .-]?\d){9}(?![\d])"),
    "email": re.compile(r"[\w.+-]+@[\w-]+(?:\.[\w-]+)+"),
    "plate": re.compile(r"\b\d{2}[A-Z]{1,2}\d?[- ]?\d{3}\.?\d{2}\b"),
    "imei": re.compile(r"IMEI\D{0,8}(\d{15})\b", re.I),
}
CONTACT_RE = re.compile(r'"name"\s*:\s*"([^"]{1,60})"\s*,\s*"phone"\s*:\s*"([^"]{6,20})"')  # danh bạ JSON
LOC_RE = re.compile(r"^(.{1,80}? dòng \d+):\s*")  # "csv dòng 3: ..." / "Sheet1 dòng 5: ..." do indexer thêm
CONTACT = "Lưu trong danh bạ"
RELS = [(n, re.compile(rx, re.I)) for n, rx in (  # loại liên kết, xét theo thứ tự trên "tên file + dòng"
    (CONTACT, r"danh.?b[aạ]|contact"),
    ("Thông tin máy", r"th[oô]ng.?tin.?m[aá]y|thuê bao|\bsim\b|imei|tài khoản (icloud|google|zalo)"),
    ("Email", r"e-?mail|thư điện tử"),
    ("Tin nhắn", r"tin.?nh[aắ]n|\bsms\b|zalo|messenger"),
    ("Cuộc gọi", r"cu[oộ]c.?g[oọ]i|g[oọ]i (đi|đến|nhỡ)|\bcall"),
    ("Giao dịch", r"giao.?d[iị]ch|chuy[eể]n (kho[aả]n|ti[eề]n)|momo|s[oố] ti[eề]n"),
    ("Ghi hình", r"camera|ghi h[iì]nh"),
)]
RANK = {n: i for i, (n, _) in enumerate(RELS)}


def norm_entity(t, v):
    if t == "phone":
        d = re.sub(r"\D", "", v)
        return "0" + d[2:] if d.startswith("84") else d
    if t == "plate":
        return re.sub(r"[\s.-]", "", v).upper()
    return v.lower() if t == "email" else v


def line_links(fname, line):
    """Một dòng dữ liệu -> (thực thể, loại liên kết, tên danh bạ {giá trị: tên}, câu gốc, vị trí trong file)."""
    found = list(dict.fromkeys((t, norm_entity(t, m.group(m.lastindex or 0)))
                               for t, rx in ENTITY_RE.items() for m in rx.finditer(line)))
    if not found:
        return None
    m = LOC_RE.match(line)
    text = line[m.end():] if m else line
    rel = next((n for n, rx in RELS if rx.search(fname + " " + line)), "Nhắc tới")
    names = {norm_entity("phone", p): n for n, p in CONTACT_RE.findall(line)}
    if rel == CONTACT and not names:  # danh bạ CSV "Lan | 0987654321 | lan@x.com": ô chữ đầu tiên là tên
        name = next((c.strip() for c in text.split(" | ") if re.search(r"[^\W\d_]", c) and not re.search(r"[\d@]", c)), None)
        names = {v: name[:60] for _, v in found} if name else {}
    return found, rel, names, text[:300], m.group(1) if m else None


def build_graph(case, devs, rows):
    """rows: (file_id, tên file, thiết bị, loc đoạn, chữ đoạn). Cạnh: thiết bị -> thực thể nó chứa;
    thực thể <-> thực thể cùng một dòng (cuộc gọi, giao dịch, danh bạ có cả SĐT + email...)."""
    known = {d["name"] for d in devs}
    ents, names, links = {}, {}, {}

    def link(a, b, rel, ev):
        e = links.setdefault((a, b) if a < b else (b, a), {"rels": {}, "ev": []})
        e["rels"][rel] = e["rels"].get(rel, 0) + 1
        if len(e["ev"]) < 30:  # đủ để đọc; tổng số vẫn đếm trong rels
            e["ev"].append(ev)

    for fid, fname, device, loc, text in rows:
        src = f"d:{device}" if device in known else "c"
        for line in text.split("\n"):
            r = line_links(fname, line)
            if not r:
                continue
            found, rel, nm, quote, line_loc = r
            names.update(nm)
            ev = {"id": fid, "file": fname, "loc": line_loc or loc, "text": quote}
            for t, v in found:
                ents.setdefault((t, v), set()).add(fid)
                link(src, f"e:{t}:{v}", rel, ev)
            # danh sách nhiều số trên một dòng (danh bạ JSON, liệt kê) không phải quan hệ giữa các số đó
            if 1 < len(found) <= 3 and not (rel == CONTACT and sum(t == "phone" for t, _ in found) > 1):
                for i, (t1, v1) in enumerate(found):
                    for t2, v2 in found[i + 1:]:
                        link(f"e:{t1}:{v1}", f"e:{t2}:{v2}", rel, ev)
    nodes = [{"id": "c", "type": "case", "label": case}]
    nodes += [{"id": f"d:{d['name']}", "type": "device", "dtype": d["type"], "label": d["name"], "files": d["count"]}
              for d in devs]
    nodes += [{"id": f"e:{t}:{v}", "type": t, "label": v, "name": names.get(v), "files": len(fs)}
              for (t, v), fs in ents.items()]
    edges = [{"from": "c", "to": f"d:{d['name']}", "rels": [["Thu giữ", 1]], "n": 1, "ev": []} for d in devs]
    edges += [{"from": a, "to": b, "rels": sorted(e["rels"].items(), key=lambda x: RANK.get(x[0], 99)),
               "n": sum(e["rels"].values()), "ev": e["ev"]} for (a, b), e in links.items()]
    return {"nodes": nodes, "edges": edges}


@app.get("/api/graph")
def graph(case: str):
    """Sơ đồ quan hệ của vụ án: vụ án -> thiết bị -> SĐT/email/biển số/IMEI; bấm cạnh xem dòng bằng chứng."""
    devs = indexer.devices(conn, case)["items"]
    if not devs and not any(c["name"] == case for c in indexer.cases(conn)):
        raise HTTPException(404, "không có vụ án")
    # shortcut: quét tối đa 20000 đoạn / vụ án (vài máy điện thoại); lớn hơn thì lưu thực thể lúc index
    rows = conn.execute("SELECT f.id, f.name, f.device, c.loc, c.text FROM chunks c JOIN files f ON f.id = c.file_id "
                        "WHERE f.collection = ? ORDER BY f.id, c.seq LIMIT 20000", (case,)).fetchall()
    return build_graph(case, devs, rows)


@app.get("/api/graph/all")
def graph_all():
    """Sơ đồ mọi vụ án: vụ án -> thiết bị -> SĐT/email/biển số/IMEI. Thực thể trùng giữa các vụ án gộp thành một
    nút (cases = số vụ án nhắc tới), nên hai vụ án có chung một số điện thoại sẽ nối với nhau qua nút đó."""
    nodes, edges, seen = {}, {}, {}
    for c in indexer.cases(conn):
        case = c["name"]

        def ren(i):  # id vụ án/thiết bị riêng theo vụ án; thực thể giữ nguyên để gộp
            return f"c:{case}" if i == "c" else f"d:{case}:{i[2:]}" if i.startswith("d:") else i

        g = graph(case)
        for n in g["nodes"]:
            i = ren(n["id"])
            if i in nodes:
                nodes[i]["files"] = (nodes[i].get("files") or 0) + (n.get("files") or 0)
                nodes[i]["name"] = nodes[i].get("name") or n.get("name")
            else:
                nodes[i] = {**n, "id": i}
            if i.startswith("e:"):
                seen.setdefault(i, set()).add(case)
        for e in g["edges"]:
            k = (ren(e["from"]), ren(e["to"]))
            old = edges.get(k)
            if old:
                rels = dict(old["rels"])
                for r, n in e["rels"]:
                    rels[r] = rels.get(r, 0) + n
                old.update(rels=sorted(rels.items(), key=lambda x: RANK.get(x[0], 99)), n=old["n"] + e["n"],
                           ev=(old["ev"] + e["ev"])[:30])
            else:
                edges[k] = {**e, "from": k[0], "to": k[1]}
    for i, cs in seen.items():
        nodes[i]["cases"] = len(cs)
    return {"nodes": list(nodes.values()), "edges": list(edges.values())}


@app.get("/api/files/{file_id}")
def file_detail(file_id: int = FileId):
    f = indexer.get_file(conn, file_id)
    if not f:
        raise HTTPException(404, "không có file")
    return with_urls(f)


def start_scan(folder, collection, busy_msg="đang index, thử lại sau", device=None):
    global current_thread
    with lock:
        if current_thread and current_thread.is_alive():
            raise HTTPException(409, busy_msg)
        current_thread = threading.Thread(target=indexer.scan, args=(str(folder), str(DATA), None, collection, device),
                                          daemon=True)
        current_thread.start()
    return {"status": "started", "folder": str(folder)}


def clean_name(s):
    """Tên thư mục/file an toàn: bỏ ký tự cấm của Windows, '..', NUL; cắt 60."""
    return re.sub(r'[\\/:*?"<>|\x00]|\.\.', "_", s.strip())[:60].strip(" .")


@app.post("/api/index")
def start_index(req: IndexReq):
    folder = Path(req.folder.replace("\x00", "").strip()).resolve()
    if not req.folder.strip() or not folder.is_dir():
        raise HTTPException(400, "thư mục không tồn tại")
    if not allowed(folder):
        raise HTTPException(400, "chỉ index thư mục dưới /evidence hoặc thư mục tải lên")
    col = (req.collection or "").strip()[:60] or None
    if req.device and (not col or req.device not in [d["name"] for d in indexer.devices(conn, col)["items"]]):
        raise HTTPException(400, "thiết bị không thuộc vụ án")
    return start_scan(folder, col, device=req.device or None)


@app.post("/api/upload")
def upload(collection: str = Form(...), device: str | None = Form(None), files: list[UploadFile] = File([])):
    collection = clean_name(collection)
    if not collection:
        raise HTTPException(400, "thiếu tên bộ dữ liệu")
    if not files:
        raise HTTPException(400, "chưa chọn file")
    if device and device not in [d["name"] for d in indexer.devices(conn, collection)["items"]]:
        raise HTTPException(400, "thiết bị không thuộc vụ án")
    if shutil.disk_usage(DATA).free < MIN_FREE:
        raise HTTPException(507, "ổ dữ liệu sắp đầy (< 5 GB trống)")
    uploads = UPLOADS
    folder = uploads / collection / device if device else uploads / collection
    folder.mkdir(parents=True, exist_ok=True)
    for f in files:
        # nhập cả thư mục: filename là đường dẫn tương đối (a/b/c.jpg) -> giữ cây thư mục, làm sạch từng phần
        parts = [p for p in (clean_name(x) for x in (f.filename or "").replace("\\", "/").split("/")) if p] or ["file"]
        sub, name = folder.joinpath(*parts[:-1]), parts[-1]
        stem, ext = os.path.splitext(name)
        dest, n = sub / name, 1
        while dest.exists():
            n += 1
            dest = sub / f"{stem}_{n}{ext}"
        if not dest.resolve().is_relative_to(uploads):
            raise HTTPException(400, "tên file không hợp lệ")
        sub.mkdir(parents=True, exist_ok=True)
        size = 0
        with dest.open("wb") as out:
            while buf := f.file.read(1 << 20):
                size += len(buf)
                if size > UPLOAD_MAX:
                    break
                out.write(buf)
        if size > UPLOAD_MAX:
            dest.unlink()
            raise HTTPException(413, f"{name} vượt quá {UPLOAD_MAX >> 20} MB")
    indexer.ensure_case(conn, collection)  # vụ án hiện ngay cả khi index còn chạy
    r = start_scan(folder, collection, f"đã lưu {len(files)} file vào {folder}, nhưng đang index; bấm Index lại sau",
                   device or None)
    return {"saved": len(files), **r}


@app.get("/api/index/status")
def index_status():
    return indexer.last_run() or {"status": "idle"}


# câu hỏi tổng quan/đếm: chunk truy hồi không đủ -> kèm danh mục rút gọn
OVERVIEW = re.compile(r"bao nhiêu|mấy (file|ảnh|video|tài liệu|tệp)|tóm tắt|tổng quan|liệt kê|danh sách|thống kê|đếm|tất cả", re.I)


@app.post("/api/ask")
def ask(req: AskReq):
    cols = list(dict.fromkeys(c for c in [req.collection, *req.extra[:10]] if c)) or None  # None = mọi vụ án
    where = f"WHERE collection IN ({','.join('?' * len(cols))})" if cols else ""
    counts = dict(conn.execute(f"SELECT kind, COUNT(*) FROM files {where} GROUP BY kind", cols or []).fetchall())
    if cols and not counts:
        raise HTTPException(400, "vụ án chưa có tài liệu")
    chunks = retrieval.search(conn, req.question, cols)
    catalog = ([f for c in cols for f in indexer.list_files(conn, None, None, 1, 150, c)["items"]][:150] if cols
               else indexer.list_files(conn, None, None, 1, 150)["items"]) \
        if not chunks or OVERVIEW.search(req.question) else []
    try:
        answer, sent = llm.answer(req.question, chunks, [m.model_dump() for m in req.history[-6:]], catalog, counts)
    except llm.LLMError as e:
        raise HTTPException(502, str(e))
    sources = []
    for i, loc in retrieval.cite(answer, sent, [f["id"] for f in catalog]).items():
        f = indexer.get_file(conn, i)
        if f:
            f = with_urls(f)
            sources.append({**{k: f.get(k) for k in ("id", "name", "kind", "thumb_url", "file_url", "caption")}, "loc": loc})
    return {"answer": answer, "sources": sources}


_tl = threading.local()


def _rconn():
    """Kết nối SQLite riêng mỗi thread cho /file và /thumb: Grid view tải hàng trăm ảnh song song,
    dùng chung `conn` giữa các thread làm request trả 404 giả hoặc 500 (sqlite3.InterfaceError)."""
    # shortcut: chỉ /file,/thumb có kết nối riêng; API khác vẫn chung `conn`, chuyển hết sang per-thread nếu gặp lỗi tương tự
    if not hasattr(_tl, "c"):
        _tl.c = sqlite3.connect(DATA / "index.db", check_same_thread=False)
        _tl.c.row_factory = sqlite3.Row
    return _tl.c


@app.get("/file/{file_id}")
def serve_file(file_id: int = FileId):
    f = indexer.get_file(_rconn(), file_id)
    p = Path(f["path"]).resolve() if f else None
    if not p or not allowed(p) or not p.is_file():
        raise HTTPException(404, "file không tồn tại")
    # sandbox: file .html/.svg trong thư mục được index không chạy script trên origin của app
    return FileResponse(p, headers={"Content-Security-Policy": "sandbox"})


@app.get("/api/fileref")
def file_ref(p: str, thumb: bool = False):
    """Tệp đã index theo đường dẫn (ảnh/video/thoại gắn trong tin nhắn) -> chuyển tới /thumb hoặc /file."""
    from fastapi.responses import RedirectResponse
    r = _rconn().execute("SELECT id, thumb FROM files WHERE path = ?", (p,)).fetchone()
    if not r:
        raise HTTPException(404, "tệp chưa được index")
    return RedirectResponse(f"/thumb/{r[0]}" if thumb and r[1] else f"/file/{r[0]}")


@app.get("/thumb/{file_id}")
def serve_thumb(file_id: int = FileId):
    f = indexer.get_file(_rconn(), file_id)
    p = DATA / f["thumb"] if f and f["thumb"] else None
    if not p or not p.is_file():
        raise HTTPException(404, "không có thumbnail")
    return FileResponse(p)


def _cpu_times():
    with open("/proc/stat") as f:
        v = [int(x) for x in f.readline().split()[1:]]
    return v[3] + v[4], sum(v)  # (idle + iowait, tổng)


@app.get("/api/system")
def system():
    """Trạng thái máy cho Dashboard; /proc trong container là của host nên đây là số của cả máy."""
    i0, t0 = _cpu_times()
    time.sleep(0.25)
    i1, t1 = _cpu_times()
    with open("/proc/meminfo") as f:
        mem = {k: int(v.split()[0]) << 10 for k, v in (line.split(":", 1) for line in f)}
    disk = shutil.disk_usage(DATA)
    gpu = None
    try:  # GPU cấp qua docker-compose; NVML có thể mất khi host reload systemd -> trả None thay vì 500
        out = subprocess.run(["nvidia-smi", "--query-gpu=name,utilization.gpu,memory.used,memory.total,temperature.gpu",
                              "--format=csv,noheader,nounits"], capture_output=True, text=True, timeout=3, check=True).stdout
        name, util, used, total, temp = [x.strip() for x in out.splitlines()[0].split(",")]
        gpu = {"name": name, "util": int(util), "mem_used": int(used) << 20, "mem_total": int(total) << 20, "temp": int(temp)}
    except (OSError, subprocess.SubprocessError, ValueError, IndexError):
        pass
    return {
        "cpu": round(100 * (1 - (i1 - i0) / max(t1 - t0, 1))),
        "cores": os.cpu_count(),
        "load": os.getloadavg()[0],
        "ram": {"used": mem["MemTotal"] - mem["MemAvailable"], "total": mem["MemTotal"]},
        "disk": {"used": disk.used, "total": disk.total},
        "gpu": gpu,
    }


USERNAME = re.compile(r"[a-z0-9._-]{3,32}")


def _pw_hash(pw: str, salt: bytes) -> str:
    return salt.hex() + ":" + hashlib.scrypt(pw.encode(), salt=salt, n=2**14, r=8, p=1).hex()


class UserReq(BaseModel):
    username: str
    password: str


@app.get("/api/users")
def list_users():
    return list(db.users.find({}, {"_id": 0, "pw_hash": 0}, sort=[("created_at", 1)]))


@app.post("/api/users")
def create_user(req: UserReq):
    u = req.username.strip().lower()
    if not USERNAME.fullmatch(u):
        raise HTTPException(400, "tên đăng nhập 3-32 ký tự: chữ không dấu, số, dấu . _ -")
    if not 8 <= len(req.password) <= 128:
        raise HTTPException(400, "mật khẩu 8-128 ký tự")
    created = indexer.now()
    try:
        db.users.insert_one({"username": u, "pw_hash": _pw_hash(req.password, os.urandom(16)), "created_at": created})
    except DuplicateKeyError:
        raise HTTPException(409, "tên đăng nhập đã tồn tại")
    return {"username": u, "created_at": created}


@app.post("/api/login")
def login(req: UserReq):
    # shortcut: chỉ kiểm tra mật khẩu lúc đăng nhập, các API khác chưa đòi phiên; cần cookie/token trước khi mở ra ngoài LAN
    if not db.users.find_one():
        return {"username": req.username.strip(), "open": True}  # chưa có tài khoản nào: giữ cách đăng nhập cũ để không khoá ai
    u = req.username.strip().lower()
    row = db.users.find_one({"username": u})
    if not row or not hmac.compare_digest(row["pw_hash"], _pw_hash(req.password, bytes.fromhex(row["pw_hash"].partition(":")[0]))):
        raise HTTPException(401, "sai tên đăng nhập hoặc mật khẩu")
    return {"username": u, "open": False}


@app.post("/api/image")
def create_image(req: ImageReq):
    """Đóng gói thư mục chứng cứ của vụ (toàn vụ hoặc 1 thiết bị) thành tar.gz + manifest SHA256."""
    case, device = clean_name(req.case), (clean_name(req.device) if req.device else "")
    src = UPLOADS / case if not device else UPLOADS / case / device
    if not src.is_dir():
        raise HTTPException(400, "không tìm thấy thư mục chứng cứ")
    def worker():
        try:
            packaging.create_package(case, src, PACKAGES)
        except Exception:  # noqa: BLE001 - create_package đã tự set error; giữ luồng
            pass
    threading.Thread(target=worker, daemon=True).start()
    _audit(conn, "package.create", case)
    return {"status": "started"}


@app.get("/api/images")
def list_images(case: str):
    case = clean_name(case)
    return list(db.packages.find({"case_name": case}, {"_id": 0, "case_name": 0, "log": 0}, sort=[("id", -1)]))


@app.get("/api/images/{img_id}/file")
def download_image(img_id: int = PathParam(ge=1)):
    row = db.packages.find_one({"id": img_id})
    if not row:
        raise HTTPException(404, "không tồn tại")
    f = PACKAGES / row["name"]
    if not f.is_file():
        raise HTTPException(404, "chưa có file gói")
    return FileResponse(f, media_type="application/gzip", filename=row["name"])


@app.post("/api/images/{img_id}/verify")
def verify_image(img_id: int = PathParam(ge=1)):
    """So manifest vs archive; cập nhật trạng thái package."""
    row = db.packages.find_one({"id": img_id})
    if not row:
        raise HTTPException(404, "không tồn tại")
    name = row["name"]
    arc = PACKAGES / name
    man = PACKAGES / (name.replace(".tar.gz", "") + ".manifest.json")
    if not (arc.is_file() and man.is_file()):
        raise HTTPException(400, "chưa có file gói hoặc manifest")
    ok, mism = packaging.verify_package(arc, man)
    status = "verified" if ok else "corrupt"
    db.packages.update_one({"id": img_id}, {"$set": {"status": status, "error": ", ".join(mism) if mism else None}})
    return {"status": status, "mismatches": mism[:50], "count": len(mism)}


def _audit(conn, action, target, detail=""):
    db.audit_log.insert_one({"id": next_id("audit_log"), "created_at": indexer.now(), "action": action, "target": target, "detail": detail or None})


_last_phone = {"serial": None}


def _track_phone(serial):
    """Ghi audit khi serial thiết bị ADB thay đổi (connect/disconnect). Gọi sau khi đọc _adb_phone()."""
    prev = _last_phone["serial"]
    if serial and serial != prev:
        _audit(conn, "phone.connect", serial)
    elif not serial and prev:
        _audit(conn, "phone.disconnect", prev)
    _last_phone["serial"] = serial


@app.get("/api/audit")
def list_audit(limit: int = Query(50, ge=1, le=200)):
    return list(db.audit_log.find({}, {"_id": 0}, sort=[("id", -1)], limit=limit))


def _csv(headers, rows):
    buf = io.StringIO()
    w = csv.writer(buf)
    w.writerow(headers); w.writerows(rows)
    return PlainTextResponse(buf.getvalue(), media_type="text/csv; charset=utf-8-sig")


@app.get("/api/sessions")
def list_sessions(case: str = ""):
    return list(db.sessions.find({"case_name": clean_name(case)} if case else {}, {"_id": 0, "files": 0}, sort=[("id", -1)], limit=50))


@app.get("/api/export/report")
def export_report(case: str = ""):
    """Báo cáo thu tập 1 vụ án: từng thiết bị + loại tài liệu, số file, dung lượng."""
    case = clean_name(case)
    if case:
        rows = conn.execute(
            "SELECT f.device, f.kind, COUNT(*), SUM(f.size) FROM files f WHERE f.collection=? GROUP BY f.device, f.kind", (case,)).fetchall()
    else:
        rows = conn.execute("SELECT f.device, f.kind, COUNT(*), SUM(f.size) FROM files f GROUP BY f.device, f.kind").fetchall()
    out, tot_f, tot_b = [], 0, 0
    for dev, kind, n, sz in rows:
        out.append([dev or "(chưa gán)", kind, n, sz or 0])
        tot_f += n; tot_b += sz or 0
    if tot_f:
        out.append(["TỔNG", "", tot_f, tot_b])
    return _csv(["Thiết bị", "Loại tài liệu", "Số file", "Dung lượng (byte)"], out)


@app.get("/api/export/devices")
def export_devices():
    agg = {(c, d): (n, sz or 0) for c, d, n, sz in conn.execute(
        "SELECT collection, device, COUNT(*), SUM(size) FROM files WHERE device IS NOT NULL GROUP BY 1, 2")}
    rows = [(d["case_name"], d["name"], d["type"], d["note"], d["created_at"], *agg.get((d["case_name"], d["name"]), (0, 0)))
            for d in db.devices.find(sort=[("case_name", 1), ("name", 1)])]
    return _csv(["Vụ án", "Thiết bị", "Loại", "Ghi chú", "Tạo lúc", "Số file", "Dung lượng (Bytes)"], rows)


@app.get("/api/export/images")
def export_images():
    rows = [[p[k] for k in ("case_name", "name", "source", "size", "sha256", "status", "created_at", "error")]
            for p in db.packages.find(sort=[("id", -1)])]
    return _csv(["Vụ án", "Tên gói", "Nguồn", "Kích thước (B)", "SHA-256", "Trạng thái", "Tạo lúc", "Lỗi"], rows)


@app.get("/api/export/audit")
def export_audit():
    rows = [[a[k] for k in ("created_at", "action", "target", "detail")] for a in db.audit_log.find(sort=[("id", -1)])]
    return _csv(["Thời gian", "Hành động", "Đối tượng", "Chi tiết"], rows)


@app.get("/{path:path}")  # SPA fallback: /chat, /evidence... trả index.html của React; phải khai báo cuối cùng
def spa(path: str):
    if not (DIST / "index.html").is_file() or path.startswith(("api/", "file/", "thumb/", "assets/")):
        raise HTTPException(404)
    f = (DIST / path).resolve()
    if f.is_file() and f.is_relative_to(DIST.resolve()):  # file tĩnh ở gốc dist: chat-bg.png, favicon.svg...
        return FileResponse(f)
    return FileResponse(DIST / "index.html")
