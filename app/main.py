import hashlib
import hmac
import json
import os
import re
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
from fastapi.responses import FileResponse, PlainTextResponse
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
    r = indexer.list_files(conn, kind, q, page, limit, collection, device)
    r["items"] = [with_urls(f) for f in r["items"]]
    return r


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
    return indexer.devices(conn, case)


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
        if (current_thread and current_thread.is_alive()) or pull_state["running"]:
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
        if (current_thread and current_thread.is_alive()) or pull_state["running"]:
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


@app.get("/api/usb")
def usb_devices():
    """Thiết bị USB đang cắm trên máy chủ, đọc /sys (không cần adb). Chỉ trả điện thoại và ổ lưu trữ để tự điền form."""
    root = Path("/sys/bus/usb/devices")
    out = []
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
                    "ios": vendor == "05ac"})
    return {"items": out}


# Kéo dữ liệu điện thoại qua adb. adb server chạy trên host (giữ USB + uỷ quyền), container nối tới qua ADB_SERVER_SOCKET.
ADB = os.environ.get("ADB", "adb")
# Thư mục chung trong bộ nhớ máy; máy không root chỉ lấy được những mục này (ảnh, video, tải về, ghi âm, media của app).
PULL_PATHS = ["/sdcard/"]
# phase: count (đếm dữ liệu trên máy) -> pull (kéo, % theo byte) -> index (lập chỉ mục, % theo index_runs)
pull_state = {"running": False, "device": None, "phase": None, "files": 0, "total_files": 0, "bytes": 0,
              "total_bytes": 0, "pct": 0, "done": False, "error": None, "log": ""}


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
        listing = _adb_shell(serial, "find /sdcard/ -type f 2>/dev/null", 120).splitlines()
        rows = []
        for path in listing[:2000]:  # giới hạn để không quá tải; đủ cho mục đích bảng kê
            path = path.strip()
            if not path:
                continue
            m = _adb_shell(serial, f"sha1sum '{path}' 2>/dev/null", 20).split()
            rows.append({"path": path, "sha1": m[0] if m else None})
        (meta / "files.json").write_text(json.dumps(rows, indent=1, ensure_ascii=False), encoding="utf-8")
    except Exception:  # noqa: BLE001 - bảng kê là tùy chọn
        pass
    # 9) Danh bạ (thông tin bạn bè) — content provider, không root, đa số máy cho đọc
    _write(meta / "contacts.txt", _adb_shell(serial, "content query --uri content://contacts/phones --projection display_name:number"))
    # 10) Nhật ký cuộc gọi — một số máy chặn, bọc ngoại lệ
    _write(meta / "call_log.txt", _adb_shell(serial, "content query --uri content://call_log/calls --projection date:number:type:duration:name --sort 'date DESC'"))
    # 11) Thông báo hiện tại (tin nhắn Zalo/FB mới nhất, OTP...) — nguồn tin nhắn không-root
    _write(meta / "notifications.txt", _adb_shell(serial, "dumpsys notification --noredact 2>/dev/null || dumpsys notification", 120))


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


def _ios_collect(serial: str, dest: Path) -> tuple[int, int]:
    """iPhone: tạo iTunes backup đầy đủ qua idevicebackup2 (không cần jailbreak). Lấy được ảnh/video
    DCIM, danh bạ, cuộc gọi, SMS và phần dữ liệu app cho phép backup; dữ liệu app chặn sandbox không lấy được."""
    bd = dest / "_ios_backup"
    bd.mkdir(parents=True, exist_ok=True)
    pull_state.update(phase="pull", log="Đang backup iPhone (giữ màn hình mở khoá, đã tin tưởng máy này)…", pct=0, files=0, bytes=0)
    r = subprocess.run(["idevicebackup2", "backup", "--full", str(bd)],
                       capture_output=True, text=True, timeout=9000)
    tail = " ".join((r.stdout or "").strip().splitlines()[-12:]) or (r.stderr or "")[:200]
    if r.returncode:
        raise RuntimeError(f"idevicebackup2 lỗi ({r.returncode}): {tail}")
    try:
        info = subprocess.run(["ideviceinfo"], capture_output=True, text=True, timeout=30).stdout
        if info:
            (dest / "_ios_info.txt").write_text(info, encoding="utf-8")
    except (OSError, subprocess.SubprocessError):
        pass
    n, s = _tree(bd)
    pull_state.update(phase="pull", files=n, bytes=s, pct=100, log=f"iPhone backup xong: {n} file, {s} bytes")
    return n, s


def _pull_worker(serial: str, case: str, device: str, dest: Path):
    sess_id = None
    try:
        dest.mkdir(parents=True, exist_ok=True)
        sess_id = next_id("sessions")
        db.sessions.insert_one({"id": sess_id, "case_name": case, "device": device, "operator": None, "started_at": indexer.now(),
                                "finished_at": None, "files": 0, "bytes": 0, "status": "running", "error": None})
        if _is_ios(serial):
            n, s = _ios_collect(serial, dest)
            indexer.scan(str(dest), str(DATA), None, case, device)
            pull_state.update(running=False, done=True, phase=None)
            if sess_id is not None:
                db.sessions.update_one({"id": sess_id}, {"$set": {"status": "done", "bytes": s, "finished_at": indexer.now()}})
            return
        sim = _sim_props(serial)
        if sim:
            (dest / "sim.txt").write_text("\n".join(f"{k} = {v}" for k, v in sim.items()) + "\n", encoding="utf-8")
        # tổng trên máy: du (KB) + số file; thư mục bị chặn quyền (Android/data) bị bỏ qua ở cả hai phía
        out = subprocess.run([ADB, "-s", serial, "shell", "du -sk /sdcard/ 2>/dev/null; find /sdcard/ -type f 2>/dev/null | wc -l"],
                             capture_output=True, text=True, timeout=600).stdout.split()
        total = int(out[0]) << 10 if out and out[0].isdigit() else 0
        pull_state.update(phase="pull", total_bytes=total, total_files=int(out[-1]) if out and out[-1].isdigit() else 0,
                          log="Đang kéo…")
        base_n, base_s = _tree(dest)  # kéo lại vào thư mục có sẵn file: chỉ tính phần mới
        log = DATA / "pull.log"
        n = s = 0
        for remote in PULL_PATHS:
            with log.open("w") as lf:  # ghi ra file, không dùng pipe: hàng nghìn dòng lỗi quyền có thể làm đầy pipe và treo adb
                proc = subprocess.Popen([ADB, "-s", serial, "pull", "-a", remote, str(dest)], stdout=lf, stderr=subprocess.STDOUT)
                while proc.poll() is None:
                    n, s = (x - b for x, b in zip(_tree(dest), (base_n, base_s)))
                    # du tính theo block nên lệch chút với kích thước thật: giữ 99% tới khi adb xong
                    pull_state.update(files=n, bytes=s, pct=min(99, round(100 * s / total)) if total else 0)
                    time.sleep(2)
        n, s = (x - b for x, b in zip(_tree(dest), (base_n, base_s)))
        last = (log.read_text(errors="replace").strip().splitlines() or [""])[-1][:200]
        if proc.returncode and not n:  # mã lỗi khác 0 cũng xảy ra khi chỉ vài file bị chặn quyền: chỉ báo lỗi khi không kéo được gì
            raise RuntimeError(last or "adb pull lỗi")
        pull_state.update(phase="pull", log="Thu thập dữ liệu hệ thống (getprop/settings/dumpsys/bugreport)…")
        try:
            _androidqf_collect(serial, dest)  # bổ sung dữ liệu hệ thống như AndroidQF; không root
        except Exception as e:  # noqa: BLE001 - thu thập phụ không được làm hỏng luồng chính
            pull_state.update(log=f"pull xong; thu thập hệ thống bỏ qua: {str(e)[:120]}")
        pull_state.update(phase="index", files=n, bytes=s, pct=100, log=last)
        indexer.scan(str(dest), str(DATA), None, case, device)  # đưa vào index như file tải lên
        pull_state.update(running=False, done=True, phase=None)
        if sess_id is not None:
            db.sessions.update_one({"id": sess_id}, {"$set": {"status": "done", "bytes": s, "finished_at": indexer.now()}})
    except Exception as e:  # noqa: BLE001 - báo nguyên trạng cho UI
        pull_state.update(running=False, phase=None, error=str(e)[:300])
        if sess_id is not None:
            db.sessions.update_one({"id": sess_id}, {"$set": {"status": "error", "error": str(e)[:200], "finished_at": indexer.now()}})


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


@app.post("/api/pull")
def pull_phone(req: PullReq):
    if pull_state["running"]:
        raise HTTPException(409, "đang kéo dữ liệu, chờ xong")
    case, device = clean_name(req.case), clean_name(req.device)
    if device not in [d["name"] for d in indexer.devices(conn, case)["items"]]:
        # Tự thêm thiết bị vào vụ án khi thu, không chặn "thiết bị không thuộc vụ án" nữa.
        db.devices.update_one({"case_name": case, "name": device},
                              {"$set": {"type": "phone"},
                               "$setOnInsert": {"created_at": indexer.now(), "note": None}}, upsert=True)
        _audit(conn, "device.create", f"{case}/{device}", "phone")
    serial = req.serial or _adb_phone()
    if not serial:
        raise HTTPException(400, "Chưa có điện thoại nào cho phép gỡ lỗi USB. Bấm 'Cho phép' trên màn hình điện thoại rồi thử lại.")
    if shutil.disk_usage(DATA).free < MIN_FREE:
        raise HTTPException(507, "ổ dữ liệu sắp đầy (< 5 GB trống)")
    dest = UPLOADS / case / device
    pull_state.update(running=True, device=device, phase="count", files=0, total_files=0, bytes=0, total_bytes=0, pct=0,
                      done=False, error=None, log="Đang đếm dữ liệu trên điện thoại…")
    threading.Thread(target=_pull_worker, args=(serial, case, device, dest), daemon=True).start()
    _audit(conn, "pull.start", f"{case}/{device}")
    return {"status": "started", "serial": serial}


@app.get("/api/pull/status")
def pull_status():
    s = dict(pull_state)
    if s["phase"] == "index":
        s["index"] = index_status()  # done/total của lần lập chỉ mục đang chạy
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
