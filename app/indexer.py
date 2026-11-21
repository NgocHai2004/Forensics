"""Quét thư mục media -> SQLite (FTS5) + thumbnail + caption qua llm.describe_image
+ bảng chunks có vị trí (docs/CONTRACT-multimodal.md mục 3)."""
import base64
import csv
import hashlib
import json
import os
import pickle
import re
import shutil
import sqlite3
import stat
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request
import xml.etree.ElementTree as ET
import zipfile
from concurrent.futures import ThreadPoolExecutor

from .db import db, strip
from datetime import datetime, timedelta
from io import BytesIO, StringIO

from PIL import Image, ImageOps

Image.MAX_IMAGE_PIXELS = 40_000_000  # ảnh điện thoại < 50 Mpx; chặn decompression bomb (image_meta raise khi vượt)

KINDS = {
    "image": "jpg jpeg png gif webp bmp tif tiff heic heif",
    "video": "mp4 mov mkv avi webm 3gp m4v",
    "audio": "mp3 m4a wav aac ogg opus amr flac",
    "document": "txt md csv json log xml pdf doc docx xls xlsx ppt pptx rtf odt ods odp zip apk jar sqlite jwt",
}
EXT_KIND = {e: k for k, exts in KINDS.items() for e in exts.split()}
TEXT_EXTS = {"txt", "md", "csv", "json", "log", "xml"}
ARCHIVE_EXTS = {"zip", "apk", "jar"}
SNIFF_EXTS = {"db", "sqlite", "sqlite3", "log"}  # đuôi hay không khớp nội dung (btsnoop .log là nhị phân): xem byte đầu
SNIFF = [(b"\xff\xd8\xff", "jpg"), (b"\x89PNG", "png"), (b"GIF8", "gif"), (b"BM", "bmp"), (b"%PDF", "pdf"),
         (b"SQLite format 3\x00", "sqlite"), (b"PK\x03\x04", "zip"), (b"ID3", "mp3"), (b"OggS", "ogg"),
         (b"fLaC", "flac"), (b"#!AMR", "amr")]
CONVERT_EXTS = {"doc", "rtf", "odt", "xls", "ods", "ppt", "odp"}  # -> docx/xlsx/pptx qua dịch vụ convert
MAX_TEXT = 50000  # ký tự lưu vào files.text_content
MAX_EXTRACT = 2_000_000  # ponytail: tối đa 2M ký tự/file vào chunks; nâng nếu có tài liệu lớn hơn cần hỏi
MAX_OCR_PAGES = 50
MAX_FRAMES = 30
ASR_URL = os.environ.get("ASR_URL", "http://asr:9001")
CONVERT_URL = os.environ.get("CONVERT_URL", "http://convert:9002")
# dịch vụ asr/convert xử lý tuần tự: xếp hàng ở đây để timeout của client chỉ tính thời gian server làm việc
ASR_LOCK, CONVERT_LOCK = threading.Semaphore(1), threading.Semaphore(1)
PDF_TIMEOUT = 300  # pdfium chạy trong tiến trình con, file hỏng làm treo thì bị giết sau 300 s
OFFICE_PARTS = {  # phần XML chứa chữ trong từng loại Office
    "docx": r"word/(document|header\d*|footer\d*|footnotes)\.xml",
    "pptx": r"ppt/slides/slide\d+\.xml",
    "xlsx": r"xl/worksheets/sheet\d+\.xml",
}
# Thư mục app trong bản sao /sdcard điện thoại (android_backup_tool: adb pull, adb backup -shared)
APP_DIRS = {d.lower(): d for d in "Zalo Messenger Facebook Telegram Threads WhatsApp Viber Instagram TikTok Screenshots "
                                  "Camera Recordings Download Documents Bluetooth".split()}


# thùng rác (ảnh đã xoá) và .thumbnails (ảnh thu nhỏ còn lại sau khi ảnh gốc bị xoá) là chứng cứ -> quét
SKIP_DIRS = {".git", ".svn", "__macosx", "system volume information"}
SKIP_FILES = {".nomedia", ".ds_store", "thumbs.db", "desktop.ini"}


def app_of(path):
    """Thư mục app gần file nhất: .../Download/Zalo/a.jpg -> 'Zalo'; không có -> None."""
    return next((APP_DIRS[d.lower()] for d in reversed(path.replace("\\", "/").split("/")[:-1]) if d.lower() in APP_DIRS), None)


csv.field_size_limit(MAX_EXTRACT)  # mặc định 128 KB: ô dài/ngoặc kép lệch làm csv.Error

SCHEMA = """
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,
  name TEXT NOT NULL,
  ext TEXT NOT NULL,
  kind TEXT NOT NULL,
  size INTEGER NOT NULL,
  mtime TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  taken_at TEXT,
  lat REAL, lon REAL,
  width INTEGER, height INTEGER,
  caption TEXT,
  ocr_text TEXT,
  tags TEXT,
  text_content TEXT,
  thumb TEXT,
  indexed_at TEXT NOT NULL,
  error TEXT,
  collection TEXT
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, caption, ocr_text, tags, text_content,
  content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS files_ai AFTER INSERT ON files BEGIN
  INSERT INTO files_fts(rowid, name, caption, ocr_text, tags, text_content)
  VALUES (new.id, new.name, new.caption, new.ocr_text, new.tags, new.text_content);
END;
CREATE TRIGGER IF NOT EXISTS files_ad AFTER DELETE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, caption, ocr_text, tags, text_content)
  VALUES ('delete', old.id, old.name, old.caption, old.ocr_text, old.tags, old.text_content);
END;
CREATE TRIGGER IF NOT EXISTS files_au AFTER UPDATE ON files BEGIN
  INSERT INTO files_fts(files_fts, rowid, name, caption, ocr_text, tags, text_content)
  VALUES ('delete', old.id, old.name, old.caption, old.ocr_text, old.tags, old.text_content);
  INSERT INTO files_fts(rowid, name, caption, ocr_text, tags, text_content)
  VALUES (new.id, new.name, new.caption, new.ocr_text, new.tags, new.text_content);
END;
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  file_id INTEGER NOT NULL,
  seq INTEGER NOT NULL,
  loc TEXT,
  source TEXT NOT NULL,
  text TEXT NOT NULL,
  embedding BLOB
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
  text, content='chunks', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_ad AFTER DELETE ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
END;
CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE OF text ON chunks BEGIN
  INSERT INTO chunks_fts(chunks_fts, rowid, text) VALUES ('delete', old.id, old.text);
  INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text);
END;
"""
RECHUNK = "chưa chia đoạn (index bản cũ): scan lại"


def now():
    return datetime.now().isoformat(timespec="seconds")


def init_db(db_path):
    os.makedirs(os.path.dirname(os.path.abspath(db_path)), exist_ok=True)
    conn = sqlite3.connect(db_path, check_same_thread=False)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA journal_mode=WAL")
    conn.executescript(SCHEMA)
    cols = [r[1] for r in conn.execute("PRAGMA table_info(files)")]
    for col in ("collection", "device"):  # DB cũ v1 thiếu collection; DB trước khi có thiết bị thiếu device
        if col not in cols:
            conn.execute(f"ALTER TABLE files ADD COLUMN {col} TEXT")
            conn.commit()
    if conn.execute("PRAGMA user_version").fetchone()[0] < 1:  # DB trước khi có chunks: xử lý lại một lần
        with conn:  # idempotent (NOT EXISTS / error IS NULL) nên 2 tiến trình cùng chạy cũng không sao
            conn.execute(  # ảnh đã có caption: tạo chunk từ caption sẵn có, không gọi lại LLM
                "INSERT INTO chunks(file_id, seq, source, text) SELECT id, 0, 'image', "
                "caption || char(10) || COALESCE(ocr_text, '') FROM files f WHERE kind='image' "
                "AND caption IS NOT NULL AND error IS NULL AND NOT EXISTS (SELECT 1 FROM chunks WHERE file_id=f.id)")
            conn.execute(  # còn lại: đánh dấu lỗi -> scan sau thử lại như file lỗi
                "UPDATE files SET error=? WHERE error IS NULL AND kind NOT IN ('image', 'other') "
                "AND NOT EXISTS (SELECT 1 FROM chunks WHERE file_id=files.id)", (RECHUNK,))
            conn.execute("PRAGMA user_version=1")
    if conn.execute("PRAGMA user_version").fetchone()[0] < 2:  # v2 nhận loại theo byte đầu, đọc SQLite/zip/jwt
        with conn:
            # file 'Khác' cũ: quét lại để đọc nội dung; -wal/-shm/-journal giờ đọc kèm CSDL chính nên bỏ dòng riêng
            junk = "(path LIKE '%-wal' OR path LIKE '%-shm' OR path LIKE '%-journal')"
            conn.execute(f"DELETE FROM chunks WHERE file_id IN (SELECT id FROM files WHERE {junk})")
            conn.execute(f"DELETE FROM files WHERE {junk}")
            conn.execute("UPDATE files SET error=? WHERE kind='other' AND error IS NULL", (RECHUNK,))
            conn.execute("PRAGMA user_version=2")
    return conn


def sha256(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(1 << 20), b""):
            h.update(chunk)
    return h.hexdigest()


def dms_to_deg(dms, ref):
    deg = float(dms[0]) + float(dms[1]) / 60 + float(dms[2]) / 3600
    return -deg if ref in ("S", "W") else deg


def image_meta(path, thumb_path):
    """Trả (width, height, taken_at, lat, lon, jpeg_1024_bytes). Ghi thumbnail 320px."""
    with Image.open(path) as im:
        if im.size[0] * im.size[1] > Image.MAX_IMAGE_PIXELS:  # Pillow chỉ cảnh báo tới 2x giới hạn
            raise Image.DecompressionBombError(f"ảnh {im.size[0]}x{im.size[1]} quá lớn")
        taken = lat = lon = None
        exif = im.getexif()
        try:
            taken = datetime.strptime(str(exif.get_ifd(0x8769).get(0x9003))[:19], "%Y:%m:%d %H:%M:%S").isoformat()
        except Exception:
            pass  # ponytail: ngày EXIF hỏng ('0000:00:00') -> None, GPS vẫn đọc tiếp
        try:
            gps = exif.get_ifd(0x8825)
            if gps.get(2) and gps.get(4):
                lat = dms_to_deg(gps[2], gps.get(1, "N"))
                lon = dms_to_deg(gps[4], gps.get(3, "E"))
        except Exception:
            pass
        rgb = ImageOps.exif_transpose(im).convert("RGB")  # ảnh dọc điện thoại (Orientation=6) xoay đúng chiều
    w, h = rgb.size
    rgb.thumbnail((1024, 1024))
    buf = BytesIO()
    rgb.save(buf, "JPEG", quality=85)
    rgb.thumbnail((320, 320))
    rgb.save(thumb_path, "JPEG", quality=85)
    return w, h, taken, lat, lon, buf.getvalue()


def clean(text):
    lines = (" ".join(l.split()) for l in text.splitlines())
    return "\n".join(l for l in lines if l)


def split_text(text, size=1000):
    """Chia ~size ký tự, cắt ở xuống dòng rồi khoảng trắng gần nhất; chỉ cắt giữa từ khi không có chỗ nào."""
    out = []
    while len(text) > size:
        cut = text.rfind("\n", size // 2, size)
        if cut < 0:
            cut = text.rfind(" ", size // 2, size)
        if cut < 0:
            cut = size
        out.append(text[:cut].strip())
        text = text[cut:].strip()
    return out + [text] if text.strip() else out


def group(units, source, merge=True, size=1000):
    """[(loc, text)] -> chunks [(loc, source, text)]. merge: gộp đơn vị liền nhau tới ~size ký tự, loc của đơn vị đầu."""
    out = []
    for loc, t in units:
        for piece in split_text(t, size):
            if merge and out and len(out[-1][2]) + len(piece) < size:
                out[-1][2] += "\n" + piece
            else:
                out.append([loc, source, piece])
    return [tuple(c) for c in out]


def hms(sec):
    s = int(sec)
    return f"{s // 3600:02d}:{s % 3600 // 60:02d}:{s % 60:02d}"


def set_chunks(conn, fid, chunks):
    conn.execute("DELETE FROM chunks WHERE file_id=?", (fid,))
    conn.executemany("INSERT INTO chunks(file_id, seq, loc, source, text) VALUES (?,?,?,?,?)",
                     [(fid, i, loc, src, t) for i, (loc, src, t) in enumerate(chunks)])


def post(url, body, timeout, lock):
    """POST JSON -> dict, xếp hàng theo lock của dịch vụ. HTTP lỗi -> RuntimeError kèm detail; không kết nối -> URLError."""
    req = urllib.request.Request(url, json.dumps(body).encode(), {"Content-Type": "application/json"})
    try:
        with lock, urllib.request.urlopen(req, timeout=timeout) as r:
            return json.load(r)
    except urllib.error.HTTPError as e:
        raise RuntimeError(f"{url} HTTP {e.code}: {e.read(300).decode('utf-8', 'replace')}") from None


def local(tag):
    return tag.rpartition("}")[2]  # "{ns}t" -> "t"


def xml_ends(zf, n):
    """(tên thẻ bỏ namespace, element) theo sự kiện 'end'. expat: tuyến tính, không entity ngoài.
    Tối đa 20 MB mỗi phần (chặn zip bomb); XML cụt/hỏng -> dừng ở chỗ hỏng, giữ phần đã đọc."""
    try:
        for _, el in ET.iterparse(BytesIO(zf.open(n).read(20 << 20))):
            yield local(el.tag), el
    except ET.ParseError:
        pass


def texts(el):
    return "".join(x.text or "" for x in el.iter() if local(x.tag) == "t")


def office_units(path, ext):
    """docx -> [(None, toàn văn)], pptx -> [("slide N", chữ)], xlsx -> [("Sheet1 dòng 5", "Sheet1 dòng 5: a | 3.5")].
    Zip hỏng... -> exception bay lên."""
    num = lambda n: int(re.sub(r"\D", "", n) or 0)  # slide10 sau slide2, không theo chữ cái
    units, total = [], 0
    with zipfile.ZipFile(path) as zf:
        names = set(zf.namelist())
        shared, sheets = [], []
        for tag, el in xml_ends(zf, "xl/sharedStrings.xml") if "xl/sharedStrings.xml" in names else ():
            if tag == "si":
                shared.append(clean(texts(el)))
                el.clear()
        # ponytail: sheetN.xml <-> tên sheet theo thứ tự trong workbook.xml (đúng với file Excel/LibreOffice tạo), không đọc rels
        epoch = datetime(1899, 12, 30)
        for tag, el in xml_ends(zf, "xl/workbook.xml") if "xl/workbook.xml" in names else ():
            if tag == "sheet":
                sheets.append(el.get("name") or "")
            elif tag == "workbookPr" and el.get("date1904") in ("1", "true"):  # file Mac Excel cũ
                epoch = datetime(1904, 1, 1)
        dates = date_styles(zf) if "xl/styles.xml" in names else set()
        for n in sorted((n for n in names if re.fullmatch(OFFICE_PARTS[ext], n)), key=lambda n: (num(n), n)):
            if ext == "xlsx":
                i = num(n)
                sheet = sheets[i - 1] if i <= len(sheets) else f"Sheet{i}"
                k = 0
                for tag, el in xml_ends(zf, n):
                    if tag != "row":
                        continue
                    k += 1
                    vals = [v for v in (cell_value(c, shared, dates, epoch) for c in el if local(c.tag) == "c") if v]
                    loc = f"{sheet} dòng {el.get('r') or k}"
                    el.clear()  # giải phóng bộ nhớ dòng đã đọc (xóa cả thuộc tính nên lấy r trước)
                    if vals:
                        units.append((loc, f"{loc}: " + " | ".join(vals)))
                        total += len(units[-1][1])
                    if total >= MAX_EXTRACT:
                        break
            else:  # w:t/a:t -> chữ; hết đoạn, w:br, w:cr, a:br -> xuống dòng; w:tab -> cách
                parts = []
                for tag, el in xml_ends(zf, n):
                    if tag == "t":
                        parts.append(el.text or "")
                    elif tag in ("p", "br", "cr"):
                        parts.append("\n")
                    elif tag == "tab":
                        parts.append(" ")
                t = clean("".join(parts))
                if t:
                    units.append((f"slide {num(n)}" if ext == "pptx" else None, t))
                    total += len(t)
            if total >= MAX_EXTRACT:
                break
    return units


def date_styles(zf):
    """Chỉ số cellXfs (thuộc tính s của ô) có định dạng ngày/giờ: numFmtId dựng sẵn 14–22, 45–47,
    hoặc numFmt tự định nghĩa có d/m/y/h/s ngoài "chuỗi", [màu/locale] và ký tự thoát (gạch chéo ngược + 1 ký tự)."""
    custom, out = {}, set()
    for tag, el in xml_ends(zf, "xl/styles.xml"):
        if tag == "numFmt":
            code = re.sub(r'"[^"]*"|\[[^\]]*\]|\\.', "", el.get("formatCode") or "").lower()
            custom[el.get("numFmtId")] = bool(re.search(r"[dmyhs]", code))
        elif tag == "cellXfs":  # cellStyleXfs cũng có <xf>, chỉ cellXfs ứng với s=
            out = {i for i, x in enumerate(c for c in el if local(c.tag) == "xf")
                   if (f := x.get("numFmtId") or "0").isdigit()
                   and (14 <= int(f) <= 22 or 45 <= int(f) <= 47 or custom.get(f))}
    return out


def cell_value(c, shared, dates=frozenset(), epoch=datetime(1899, 12, 30)):
    """Ô xlsx -> chuỗi: t="s" chỉ số sharedStrings, inlineStr, số có style ngày -> ISO, còn lại lấy nguyên <v>."""
    t = c.get("t")
    if t == "inlineStr":
        return clean(texts(c))
    v = next(((x.text or "").strip() for x in c if local(x.tag) == "v"), "")
    if t == "s":
        return shared[int(v)] if v.isdigit() and int(v) < len(shared) else ""
    s = c.get("s")
    if t in (None, "n") and s and s.isdigit() and int(s) in dates:
        try:
            d = epoch + timedelta(days=float(v))
        except (ValueError, OverflowError):
            return v
        d = d.replace(microsecond=0) + timedelta(seconds=round(d.microsecond / 1e6))
        if float(v) % 1 == 0:
            return d.date().isoformat()
        return d.time().isoformat() if float(v) < 1 else d.isoformat(sep=" ")
    return v


def sniff_ext(path):
    """Đuôi theo byte đầu file (file không đuôi / đuôi lạ trên điện thoại); không nhận ra -> ''."""
    with open(path, "rb") as f:
        head = f.read(16)
    if head[4:8] == b"ftyp":  # mp4/mov/m4a/3gp
        return "m4a" if head[8:11] == b"M4A" else "mp4"
    if head[:4] == b"RIFF":
        return {b"WEBP": "webp", b"WAVE": "wav", b"AVI ": "avi"}.get(head[8:12], "")
    return next((e for m, e in SNIFF if head.startswith(m)), "")


def sqlite_units(path):
    """CSDL SQLite của app -> [("bảng dòng N", "bảng dòng N: cột=giá trị | ...")]. Chép ra thư mục tạm cùng file -wal
    (dữ liệu mới chưa ghi vào file chính) rồi mở bản chép: không đụng file chứng cứ, không sinh -wal/-shm mới."""
    units, total = [], 0
    with tempfile.TemporaryDirectory() as tmp:
        db = os.path.join(tmp, "db")
        shutil.copyfile(path, db)
        if os.path.isfile(path + "-wal"):
            shutil.copyfile(path + "-wal", db + "-wal")
        conn = sqlite3.connect(db)
        conn.text_factory = lambda b: b.decode("utf-8", "replace")
        try:
            tables = [r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table' "
                                                  "AND name NOT LIKE 'sqlite_%' AND name NOT LIKE 'android_metadata'")]
            for t in tables:
                cur = conn.execute(f'SELECT * FROM "{t.replace(chr(34), chr(34) * 2)}"')
                cols = [d[0] for d in cur.description]
                for n, row in enumerate(cur, 1):
                    # blob (ảnh/khóa nhị phân) chỉ ghi kích thước; chữ dài cắt 500 ký tự
                    vals = [f"{c}=" + (f"<blob {len(v)} B>" if isinstance(v, bytes) else str(v)[:500])
                            for c, v in zip(cols, row) if v not in (None, "", b"")]
                    if vals:
                        loc = f"{t} dòng {n}"
                        units.append((loc, f"{loc}: " + " | ".join(vals)))
                        total += len(units[-1][1])
                    if total >= MAX_EXTRACT:
                        return units
        finally:
            conn.close()
    return units


def archive_units(path):
    """zip/apk/jar -> danh sách file bên trong; apk thì kèm package/quyền đọc được từ chuỗi trong AndroidManifest.xml
    (manifest đã biên dịch nhị phân, không giải đầy đủ). Nén hỏng -> exception."""
    with zipfile.ZipFile(path) as zf:
        infos = zf.infolist()
        lines = [f"{len(infos)} mục trong file nén"] + [f"{i.filename} ({i.file_size} B)" for i in infos[:2000]]
        if "AndroidManifest.xml" in zf.namelist():
            raw = zf.open("AndroidManifest.xml").read(2 << 20).decode("utf-16-le", "ignore")
            words = sorted(set(re.findall(r"[a-zA-Z][\w]*(?:\.[\w]+){2,}", raw)))
            lines.insert(1, "Manifest: " + " ".join(w for w in words if "permission" in w.lower() or w.count(".") >= 2)[:5000])
    return [(None, "\n".join(lines))]


def jwt_text(path):
    """JWT (header.payload.sig, base64url) -> header + payload dạng JSON đọc được; chữ ký bỏ."""
    parts = read_text(path).strip().split(".")
    out = []
    for p in parts[:2]:
        try:
            out.append(base64.urlsafe_b64decode(p + "=" * (-len(p) % 4)).decode("utf-8", "replace"))
        except ValueError:
            pass
    if not out:
        raise ValueError("không phải JWT")
    return "\n".join(out)


def read_text(path):
    """txt/csv: UTF-16 khi có BOM (xuất từ Windows/công cụ forensic), còn lại UTF-8 (bỏ BOM nếu có)."""
    with open(path, "rb") as f:
        raw = f.read(MAX_EXTRACT * 2)
    enc = "utf-16" if raw[:2] in (b"\xff\xfe", b"\xfe\xff") else "utf-8-sig"
    return raw.decode(enc, "replace").replace("\r\n", "\n")[:MAX_EXTRACT]


def csv_units(path):
    data = read_text(path)
    try:
        dialect = csv.Sniffer().sniff(data[:4096], ",;\t|")
    except csv.Error:
        dialect = csv.excel
    units = []
    try:
        for n, row in enumerate(csv.reader(StringIO(data), dialect), 1):
            vals = [v.strip() for v in row if v.strip()]
            if vals:
                units.append((f"csv dòng {n}", f"csv dòng {n}: " + " | ".join(vals)))
    except csv.Error:  # ngoặc kép lệch, ... -> coi như văn bản thường
        return [(None, data)]
    return units


def pdf_pages(path):
    """Chạy trong tiến trình con (pdfium không thread-safe, có thể treo với file hỏng).
    -> ([("trang N", chữ)], [("trang N", jpeg trang scan)])."""
    import pypdfium2 as pdfium
    pages, scans, total = [], [], 0
    pdf = pdfium.PdfDocument(path)
    for i in range(len(pdf)):
        page = pdf[i]
        t = clean(page.get_textpage().get_text_range())
        if len(t) >= 20:  # ponytail: trang chỉ có số trang/dấu mộc nhỏ coi như trang scan
            pages.append((f"trang {i + 1}", t))
            total += len(t)
        elif len(scans) < MAX_OCR_PAGES:  # ponytail: quá 50 trang scan thì bỏ phần sau
            buf = BytesIO()
            page.render(scale=1600 / max(page.get_size())).to_pil().convert("RGB").save(buf, "JPEG", quality=85)
            scans.append((f"trang {i + 1}", buf.getvalue()))
        if total >= MAX_EXTRACT:
            break
    pdf.close()
    return pages, scans


def describe(llm, jpeg, fails):
    """llm.describe_image; lỗi -> ghi vào fails, trả None (bỏ khung/trang đó, giữ phần còn lại của file)."""
    try:
        return llm.describe_image(jpeg)
    except Exception as e:
        fails.append(f"{type(e).__name__}: {e}")


def pdf_chunks(path, llm, fails):
    """Trang có chữ -> source 'text'; trang scan (< 20 ký tự) -> render -> describe_image -> 'ocr'. loc "trang N"."""
    # chạy dạng module (-m) từ thư mục cha của package để `from .db import` ở đầu file vẫn hợp lệ trong tiến trình con
    r = subprocess.run([sys.executable, "-m", f"{__package__}.{os.path.splitext(os.path.basename(__file__))[0]}", "--pdf", path],
                       capture_output=True, timeout=PDF_TIMEOUT, cwd=os.path.dirname(os.path.dirname(os.path.abspath(__file__))))
    if r.returncode:
        raise RuntimeError(f"pdfium: {r.stderr.decode('utf-8', 'replace').strip().splitlines()[-1:]}")
    pages, scans = pickle.loads(r.stdout)  # dữ liệu từ chính tiến trình con của mình
    chunks = group(pages, "text", merge=False)
    for loc, jpeg in scans:
        if d := describe(llm, jpeg, fails):
            chunks.append((loc, "ocr", f"{d['caption']}\n{d['ocr_text']}".strip()))
    return sorted(chunks, key=lambda c: int(c[0].split()[1]))


def video_frames(path):
    """-> (width, height, [(giây, jpeg)]): khung đầu + khung đổi cảnh, cách nhau >= 2 s, tối đa MAX_FRAMES."""
    with tempfile.TemporaryDirectory() as tmp:
        # ponytail: chỉ giải mã keyframe (-skip_frame nokey) cho nhanh; tối đa 300 ứng viên nên video rất dài
        # (hàng trăm lần đổi cảnh) chỉ lấy khung ở phần đầu; timeout 30 phút
        r = subprocess.run(
            ["ffmpeg", "-nostdin", "-hide_banner", "-skip_frame", "nokey", "-i", path, "-vf",
             "select='eq(n,0)+gt(scene,0.3)',showinfo,scale=1024:1024:force_original_aspect_ratio=decrease",
             "-fps_mode", "vfr", "-frames:v", "300", "-q:v", "3", os.path.join(tmp, "%04d.jpg")],
            capture_output=True, text=True, errors="replace", timeout=1800)
        size = re.search(r"Stream #.*?Video: .*?\b(\d{2,5})x(\d{2,5})\b", r.stderr)
        times = [float(t) for t in re.findall(r"\bpts_time:\s*(-?[\d.]+)", r.stderr)]
        frames, last = [], None
        for t, name in zip(times, sorted(os.listdir(tmp))):
            if last is None or t - last >= 2:
                with open(os.path.join(tmp, name), "rb") as f:
                    frames.append((max(t, 0.0), f.read()))
                last = t
    if len(frames) > MAX_FRAMES:  # rải đều, luôn giữ khung đầu
        frames = [frames[i * len(frames) // MAX_FRAMES] for i in range(MAX_FRAMES)]
    return (int(size[1]), int(size[2])) if size else (None, None), frames


def scan(folder, data_dir, progress=None, collection=None, device=None):
    from . import llm

    conn = init_db(os.path.join(data_dir, "index.db"))
    if collection:
        ensure_case(conn, collection)
    os.makedirs(os.path.join(data_dir, "thumbs"), exist_ok=True)
    run_id = db.index_runs.insert_one({"folder": os.path.abspath(folder), "started_at": now(), "finished_at": None,
                                       "total": 0, "done": 0, "status": "running", "message": None}).inserted_id
    run = lambda **f: db.index_runs.update_one({"_id": run_id}, {"$set": f})
    processed = 0
    try:
        paths, data_abs = [], os.path.normcase(os.path.abspath(data_dir))
        for root, dirs, names in os.walk(folder):
            # thư mục ẩn trên điện thoại (.gs_fs0 cache ảnh app, .keyguard hình khoá màn hình...) là chứng cứ -> vẫn quét;
            # chỉ bỏ rác đã biết (ảnh thu nhỏ, thùng rác, metadata git/Windows/macOS)
            dirs[:] = [d for d in dirs if d.lower() not in SKIP_DIRS
                       and os.path.normcase(os.path.abspath(os.path.join(root, d))) != data_abs]  # không index chính data/
            # chỉ file thường: symlink (-> /proc/self/environ), thiết bị (/dev/zero), FIFO (treo scan) bị bỏ.
            # -wal/-shm/-journal của SQLite được đọc kèm file CSDL chính, không index riêng
            paths += [p for p in (os.path.abspath(os.path.join(root, n)) for n in names if n.lower() not in SKIP_FILES
                                  and not n.lower().endswith(("-wal", "-shm", "-journal")))
                      if stat.S_ISREG(os.lstat(p).st_mode)]
        total = len(paths)
        run(total=total)
        local, conns = threading.local(), []

        def work(path):  # mỗi worker một connection SQLite riêng (connection không dùng chung giữa thread)
            if not hasattr(local, "conn"):
                local.conn = init_db(os.path.join(data_dir, "index.db"))
                conns.append(local.conn)
            c = local.conn
            try:
                return index_one(c, llm, path, data_dir, collection, device)
            except Exception as e:  # file khóa, path > 260 ký tự, mtime lỗi... -> ghi lỗi, đi tiếp
                c.rollback()
                ext = os.path.splitext(path)[1][1:].lower()
                c.execute(
                    "INSERT INTO files(path,name,ext,kind,size,mtime,sha256,indexed_at,error) VALUES (?,?,?,?,0,'','',?,?) "
                    "ON CONFLICT(path) DO UPDATE SET error=excluded.error, indexed_at=excluded.indexed_at",
                    (path, os.path.basename(path), ext, EXT_KIND.get(ext, "other"), now(), f"{type(e).__name__}: {e}"[:500]))
                c.commit()
                return False

        # ponytail: song song theo file (thời gian chủ yếu chờ LLM/ASR); ghi SQLite vẫn tuần tự nhờ khóa WAL
        with ThreadPoolExecutor(max(1, int(os.environ.get("INDEX_WORKERS", "1")))) as pool:
            results = pool.map(work, paths)
            for done, ok in enumerate(results, 1):
                processed += ok
                if progress:
                    progress(done, total)
                if done % 5 == 0:
                    run(done=done)
        for c in conns:
            c.close()
        try:  # embedding cho chunk mới; Ollama lỗi / chưa có retrieval.py -> lần scan sau embed tiếp
            from . import retrieval
            retrieval.embed_pending(conn)
        except Exception as e:
            print(f"embed_pending lỗi: {type(e).__name__}: {e}")
        run(done=total, status="done", finished_at=now())
    except Exception as e:
        run(status="error", message=f"{type(e).__name__}: {e}"[:500], finished_at=now())
    conn.close()
    return processed


def index_one(conn, llm, path, data_dir, collection=None, device=None):
    """Index một file; trả True nếu xử lý, False nếu không đổi (file lỗi lần trước sẽ được thử lại)."""
    st = os.stat(path)
    mtime = datetime.fromtimestamp(st.st_mtime).isoformat(timespec="seconds")
    if conn.execute("SELECT 1 FROM files WHERE path=? AND size=? AND mtime=? AND error IS NULL",
                    (path, st.st_size, mtime)).fetchone():
        return False
    name = os.path.basename(path)
    ext = os.path.splitext(name)[1][1:].lower()
    if (ext not in EXT_KIND or ext in SNIFF_EXTS) and st.st_size:  # không đuôi / đuôi lạ: nhận theo nội dung
        ext = sniff_ext(path) or ext
    kind = EXT_KIND.get(ext, "other")
    row = dict(path=path, name=name, ext=ext, kind=kind, size=st.st_size, mtime=mtime,
               sha256=sha256(path), indexed_at=now(), taken_at=None, lat=None, lon=None,
               width=None, height=None, caption=None, ocr_text=None, tags=None,
               text_content=None, thumb=None, error=None, collection=collection, device=device)
    fid = conn.execute(
        "INSERT INTO files(path,name,ext,kind,size,mtime,sha256,indexed_at,error) VALUES "
        "(:path,:name,:ext,:kind,:size,:mtime,:sha256,:indexed_at,'đang index') ON CONFLICT(path) DO UPDATE SET "
        "ext=excluded.ext, kind=excluded.kind, "
        "size=excluded.size, mtime=excluded.mtime, sha256=excluded.sha256, indexed_at=excluded.indexed_at, "
        "error=excluded.error RETURNING id", row).fetchone()[0]
    # commit ngay để không giữ khóa ghi SQLite trong lúc chờ LLM/ASR (worker kia sẽ "database is locked");
    # error tạm 'đang index' bảo đảm nếu dừng giữa chừng, lần scan sau vẫn thử lại
    conn.commit()
    chunks, thumb, fails = [], f"thumbs/{fid}.jpg", []  # fails: khung/trang scan mô tả lỗi, bỏ qua từng cái
    try:
        if kind == "image":
            row["width"], row["height"], row["taken_at"], row["lat"], row["lon"], jpeg =                 image_meta(path, os.path.join(data_dir, thumb))
            row["thumb"] = thumb
            d = llm.describe_image(jpeg)
            row["caption"], row["ocr_text"] = d["caption"], d["ocr_text"]
            row["tags"] = json.dumps(d["tags"], ensure_ascii=False)
            chunks = [(None, "image", f"{d['caption']}\n{d['ocr_text']}")]
        elif kind in ("audio", "video"):
            # ponytail: ASR cả file một lần (timeout 30 phút); file dài hơn ~vài giờ cần cắt đoạn phía ASR
            segs = post(f"{ASR_URL}/transcribe", {"path": path}, 1800, ASR_LOCK)["segments"]
            chunks = group([(hms(s["start"]), s["text"].strip()) for s in segs if s["text"].strip()], "asr")
            row["text_content"] = "\n".join(s["text"].strip() for s in segs)[:MAX_TEXT]
            if kind == "video":
                (row["width"], row["height"]), frames = video_frames(path)
                for i, (t, jpeg) in enumerate(frames):
                    if i == 0:
                        with Image.open(BytesIO(jpeg)) as im:
                            im.thumbnail((320, 320))
                            im.save(os.path.join(data_dir, thumb), "JPEG", quality=85)
                        row["thumb"] = thumb
                    if not (d := describe(llm, jpeg, fails)):
                        continue
                    if row["caption"] is None:
                        row["caption"], row["ocr_text"] = d["caption"], d["ocr_text"]
                        row["tags"] = json.dumps(d["tags"], ensure_ascii=False)
                    chunks.append((hms(t), "frame", f"[khung hình] {d['caption']} | chữ: {d['ocr_text']}"))
                chunks.sort(key=lambda c: c[0])  # asr + frame xen kẽ theo thời gian
        elif ext == "csv":
            chunks = group(csv_units(path), "text")
        elif ext == "sqlite":
            chunks = group(sqlite_units(path), "text")
        elif ext in ARCHIVE_EXTS:
            chunks = group(archive_units(path), "text", merge=False)
        elif ext == "jwt":
            chunks = group([(None, jwt_text(path))], "text", merge=False)
        elif ext in TEXT_EXTS:
            chunks = group([(None, read_text(path))], "text", merge=False)
        elif ext == "pdf":
            chunks = pdf_chunks(path, llm, fails)
        elif ext in CONVERT_EXTS or ext in OFFICE_PARTS:
            src = post(f"{CONVERT_URL}/convert", {"path": path}, 180, CONVERT_LOCK)["path"] if ext in CONVERT_EXTS else path
            sub = os.path.splitext(src)[1][1:].lower()
            chunks = group(office_units(src, sub), "text", merge=sub != "pptx")
    except Exception as e:  # LLMError, ASR/convert tắt, zip hỏng, pdf mã hóa, HEIC... -> ghi lỗi, scan sau thử lại
        row["error"] = f"{type(e).__name__}: {e}"[:500]
        chunks = []
    if chunks and (app := app_of(path)):  # hỏi "ảnh nhận qua Zalo" / tìm "Zalo" ra đúng file
        chunks = [(loc, src_, f"[Nguồn: {app}] {t}") for loc, src_, t in chunks]
    if fails:
        # ponytail: có chunk thì không đặt error (tránh chạy lại ASR 30 phút mỗi scan); khung/trang lỗi chỉ log,
        # không thử lại. Cần thử lại riêng từng khung thì thêm cột/bảng ghi chú.
        print(f"{path}: {len(fails)} khung/trang mô tả lỗi, bỏ qua: {fails[0]}"[:500])
        if not chunks:
            row["error"] = f"{len(fails)} khung/trang lỗi: {fails[0]}"[:500]
    if kind != "image" and row["text_content"] is None and chunks:
        row["text_content"] = "\n".join(c[2] for c in chunks)[:MAX_TEXT]
    conn.execute(
        "UPDATE files SET taken_at=:taken_at, lat=:lat, lon=:lon, width=:width, height=:height, "
        "caption=:caption, ocr_text=:ocr_text, tags=:tags, text_content=:text_content, "
        "thumb=:thumb, error=:error, collection=COALESCE(:collection, collection), device=COALESCE(:device, device) "
        "WHERE id=:id", {**row, "id": fid})
    set_chunks(conn, fid, chunks)
    conn.commit()
    return True


def by_day(conn, days=7):
    """Số file theo ngày trong `days` ngày gần nhất (tính cả hôm nay, giờ của container), ngày trống = 0."""
    today = datetime.now().date()
    start = today - timedelta(days=days - 1)
    got = dict(conn.execute("SELECT substr(COALESCE(taken_at, mtime),1,10) AS d, COUNT(*) FROM files "
                            "WHERE substr(COALESCE(taken_at, mtime),1,10) BETWEEN ? AND ? GROUP BY d",
                            (start.isoformat(), today.isoformat())).fetchall())
    return [{"day": (start + timedelta(i)).isoformat(), "count": got.get((start + timedelta(i)).isoformat(), 0)}
            for i in range(days)]


def stats(conn):
    q = lambda sql: conn.execute(sql).fetchone()[0]
    last = last_run()
    return {
        "total": q("SELECT COUNT(*) FROM files"),
        "total_size": q("SELECT COALESCE(SUM(size),0) FROM files"),
        "by_kind": dict(conn.execute("SELECT kind, COUNT(*) FROM files GROUP BY kind").fetchall()),
        "by_month": [dict(r) for r in conn.execute(
            "SELECT substr(COALESCE(taken_at, mtime),1,7) AS month, COUNT(*) AS count "
            "FROM files GROUP BY month ORDER BY month")],
        "by_day": by_day(conn),
        "with_gps": q("SELECT COUNT(*) FROM files WHERE lat IS NOT NULL"),
        "captioned": q("SELECT COUNT(*) FROM files WHERE caption IS NOT NULL"),
        "errors": q("SELECT COUNT(*) FROM files WHERE error IS NOT NULL"),
        "last_run": last,
    }


def search(conn, keywords, limit=40):
    keywords = [k.replace("\x00", "").strip() for k in keywords if k and k.strip()]
    if not keywords:
        return []
    match = " OR ".join('"' + k.replace('"', '""') + '"' for k in keywords)
    rows = conn.execute(
        "SELECT f.* FROM files_fts JOIN files f ON f.id = files_fts.rowid "
        "WHERE files_fts MATCH ? ORDER BY bm25(files_fts) LIMIT ?", (match, limit))
    return [dict(r) for r in rows]


def list_files(conn, kind, q, page, limit, collection=None, device=None):
    if q:
        # ponytail: lọc kind/collection/device trong Python trên tối đa 1000 hit FTS; đủ cho một thư mục điện thoại
        items = [r for r in search(conn, [q], 1000) if (kind is None or r["kind"] == kind)
                 and (collection is None or r["collection"] == collection) and (device is None or r["device"] == device)]
        total, items = len(items), items[(page - 1) * limit:page * limit]
    else:
        conds = [(c, v) for c, v in (("kind=?", kind), ("collection=?", collection), ("device=?", device)) if v]
        where = "WHERE " + " AND ".join(c for c, _ in conds) if conds else ""
        args = [v for _, v in conds]
        total = conn.execute(f"SELECT COUNT(*) FROM files {where}", args).fetchone()[0]
        items = [dict(r) for r in conn.execute(
            f"SELECT * FROM files {where} ORDER BY COALESCE(taken_at, mtime) DESC LIMIT ? OFFSET ?",
            args + [limit, (page - 1) * limit])]
    return {"items": items, "total": total, "page": page, "limit": limit}


def collections(conn):
    return [dict(r) for r in conn.execute(
        "SELECT collection, COUNT(*) AS count FROM files WHERE collection IS NOT NULL "
        "GROUP BY collection ORDER BY count DESC")]


def last_run():
    r = db.index_runs.find_one(sort=[("_id", -1)])
    return strip(r) if r else None


def ensure_case(conn, name):
    db.cases.update_one({"name": name}, {"$setOnInsert": {"note": None, "created_at": now()}}, upsert=True)


def cases(conn):
    """Bảng cases + vụ án chỉ có trong files (created_at = MIN(indexed_at)), kèm count/by_kind/device_count."""
    kinds = {}
    for col, kind, n in conn.execute(
            "SELECT collection, kind, COUNT(*) FROM files WHERE collection IS NOT NULL GROUP BY 1, 2"):
        kinds.setdefault(col, {})[kind] = n
    devs = {d["_id"]: d["n"] for d in db.devices.aggregate([{"$group": {"_id": "$case_name", "n": {"$sum": 1}}}])}
    rows = [strip(c) for c in db.cases.find()]
    named = {r["name"] for r in rows}
    rows += [{"name": col, "note": None, "created_at": first} for col, first in conn.execute(
        "SELECT collection, MIN(indexed_at) FROM files WHERE collection IS NOT NULL GROUP BY collection") if col not in named]
    rows.sort(key=lambda r: r["created_at"], reverse=True)
    return [{**r, "count": sum(kinds.get(r["name"], {}).values()), "by_kind": kinds.get(r["name"], {}),
             "device_count": devs.get(r["name"], 0)} for r in rows]


def devices(conn, case):
    """Thiết bị thu giữ của một vụ án, kèm số file; unassigned = file của vụ án chưa gán thiết bị."""
    n = dict(conn.execute("SELECT device, COUNT(*) FROM files WHERE collection=? GROUP BY device", (case,)).fetchall())
    rows = db.devices.find({"case_name": case}, {"_id": 0, "case_name": 0}, sort=[("created_at", 1), ("name", 1)])
    return {"items": [{**r, "count": n.get(r["name"], 0)} for r in rows], "unassigned": n.get(None, 0)}


def get_file(conn, file_id):
    r = conn.execute("SELECT * FROM files WHERE id=?", (file_id,)).fetchone()
    return dict(r) if r else None



if __name__ == "__main__" and sys.argv[1:2] == ["--pdf"]:  # tiến trình con của pdf_chunks
    sys.stdout.buffer.write(pickle.dumps(pdf_pages(sys.argv[2])))
elif __name__ == "__main__":
    import shutil
    import sys
    import types
    from PIL import ImageDraw

    fake = types.ModuleType("app.llm")
    fake.LLMError = Exception
    fake.describe_image = lambda b: {"caption": "ảnh thử nghiệm có xe máy", "ocr_text": "HELLO", "tags": ["xe máy"]}
    sys.modules["app.llm"] = fake
    sys.modules["app.retrieval"] = types.SimpleNamespace(embed_pending=lambda c: 1 / 0)  # lỗi embed không làm hỏng scan

    # chia chunk: không cắt giữa từ, gộp đơn vị, giữ loc đơn vị đầu
    words = " ".join(f"từ{i}" for i in range(600))
    parts = split_text(words)
    assert all(len(p) <= 1000 for p in parts) and " ".join(parts) == words and len(parts) == 4, [len(p) for p in parts]
    assert split_text("x" * 2500) == ["x" * 1000, "x" * 1000, "x" * 500] and split_text("  ") == []
    assert group([("a", "một"), ("b", "hai"), ("c", "x" * 999)], "asr") == [("a", "asr", "một\nhai"), ("c", "asr", "x" * 999)]
    assert hms(3725.9) == "01:02:05"
    assert app_of("/data/uploads/vụ/ĐT/sdcard/Download/Zalo/a.jpg") == "Zalo"
    assert app_of("/data/uploads/vụ/ĐT/sdcard/DCIM/Camera/IMG1.jpg") == "Camera"
    assert app_of("/data/uploads/vụ/ĐT/ghi_chu.txt") is None and app_of("Zalo") is None
    with tempfile.TemporaryDirectory() as tmp:  # thư mục ẩn của app + thùng rác + ảnh thu nhỏ vẫn quét, rác đã biết thì bỏ
        for f in (".gs_fs0/a.txt", ".keyguard/b.txt", ".thumbnails/c.txt", ".Trash/x/g.txt", "d/.nomedia", ".git/e.txt",
                  "m.db-wal", "m.db-shm"):
            os.makedirs(os.path.dirname(os.path.join(tmp, "src", f)), exist_ok=True)
            open(os.path.join(tmp, "src", f), "w").write("x")
        sys.modules.setdefault("app.llm", types.SimpleNamespace(describe_image=None, LLMError=Exception))
        assert scan(os.path.join(tmp, "src"), os.path.join(tmp, "data")) == 4

    # file không đuôi / đuôi lạ trên điện thoại: nhận theo byte đầu; đọc SQLite (kèm -wal), zip/apk, jwt
    with tempfile.TemporaryDirectory() as tmp:
        src, data = os.path.join(tmp, "src"), os.path.join(tmp, "data")
        os.makedirs(src)
        Image.new("RGB", (64, 48), "red").save(os.path.join(src, "wallpaper"), "PNG")
        with open(os.path.join(src, "btsnoop.log"), "wb") as f:
            f.write(b"btsnoop\x00\x00\x00\x00\x01")
        msgdb = sqlite3.connect(os.path.join(src, "msg.db"))
        msgdb.execute("PRAGMA journal_mode=WAL")
        msgdb.execute('CREATE TABLE "tin nhắn"(sdt TEXT, noi_dung TEXT, anh BLOB, trong TEXT)')
        msgdb.execute("INSERT INTO \"tin nhắn\" VALUES ('0912345678', 'hẹn gặp ở cầu', x'0102', NULL)")
        msgdb.commit()  # chưa checkpoint: dòng mới chỉ nằm trong msg.db-wal
        assert os.path.getsize(os.path.join(src, "msg.db-wal")) > 0
        with zipfile.ZipFile(os.path.join(src, "app.apk"), "w") as z:
            z.writestr("AndroidManifest.xml", "com.vi.du android.permission.READ_SMS".encode("utf-16-le"))
            z.writestr("classes.dex", b"x")
        tok = lambda d: base64.urlsafe_b64encode(json.dumps(d).encode()).decode().rstrip("=")
        with open(os.path.join(src, "cfg.jwt"), "w") as f:
            f.write(f"{tok({'alg': 'RS256'})}.{tok({'sub': 'nguoidung@x.com'})}.chuky")
        assert sniff_ext(os.path.join(src, "wallpaper")) == "png" and sniff_ext(os.path.join(src, "btsnoop.log")) == ""
        assert scan(src, data) == 5, "msg.db-wal không index riêng"
        conn = init_db(os.path.join(data, "index.db"))
        k = {r[0]: (r[1], r[2], r[3]) for r in conn.execute("SELECT name, ext, kind, error FROM files")}
        assert k["wallpaper"] == ("png", "image", None) and k["msg.db"][:2] == ("sqlite", "document"), k
        assert k["btsnoop.log"][1] == "document", k
        for word, name in (("0912345678", "msg.db"), ("READ_SMS", "app.apk"), ("classes", "app.apk"), ("nguoidung", "cfg.jwt")):
            assert [r["name"] for r in search(conn, [word])] == [name], word
        t = conn.execute("SELECT text FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.name='msg.db'").fetchone()[0]
        assert t == "tin nhắn dòng 1: sdt=0912345678 | noi_dung=hẹn gặp ở cầu | anh=<blob 2 B>", t
        # DB v1: file từng bị xếp 'other' + dòng -wal index riêng -> lên v2 quét lại đúng loại, bỏ dòng -wal
        conn.execute("UPDATE files SET kind='other', ext='' WHERE name='wallpaper'")
        conn.execute("INSERT INTO files(path,name,ext,kind,size,mtime,sha256,indexed_at) VALUES ('/x/m.db-wal','m.db-wal','','other',1,'','','')")
        conn.execute("PRAGMA user_version=1")
        conn.commit()
        conn.close()
        conn = init_db(os.path.join(data, "index.db"))
        assert conn.execute("SELECT COUNT(*) FROM files WHERE name='m.db-wal'").fetchone()[0] == 0
        assert scan(src, data) == 1
        assert tuple(conn.execute("SELECT ext, kind FROM files WHERE name='wallpaper'").fetchone()) == ("png", "image")
        conn.close()
        msgdb.close()  # đóng sau cùng: close gộp -wal vào msg.db, làm msg.db đổi và bị quét lại

    with tempfile.TemporaryDirectory() as tmp:
        src, data = os.path.join(tmp, "src"), os.path.join(tmp, "data")
        os.makedirs(src)
        for i, color in enumerate(["red", "green", "blue"]):
            im = Image.new("RGB", (640, 480), color)
            if i == 0:
                ImageDraw.Draw(im).text((20, 20), "HELLO", fill="white")
            im.save(os.path.join(src, f"img{i}.png"))
        with open(os.path.join(src, "note.txt"), "w", encoding="utf-8") as f:
            f.write("ghi chú thử nghiệm")

        assert scan(src, data) == 4
        conn = init_db(os.path.join(data, "index.db"))
        assert conn.execute("SELECT COUNT(*) FROM files").fetchone()[0] == 4
        assert all(os.path.exists(os.path.join(data, r["thumb"])) for r in
                   conn.execute("SELECT thumb FROM files WHERE kind='image'")), "thumbs"
        s = stats(conn)
        assert s["by_kind"] == {"image": 3, "document": 1}, s["by_kind"]
        assert s["last_run"]["status"] == "done" and s["errors"] == 0, s["last_run"]
        assert len(search(conn, ["xe máy"])) == 3
        assert len(search(conn, ["hello"])) == 3
        assert conn.execute("SELECT COUNT(*) FROM chunks WHERE source='image' AND text LIKE '%HELLO'").fetchone()[0] == 3
        assert list_files(conn, "document", None, 1, 10)["total"] == 1
        assert get_file(conn, 1)["name"].startswith("img")
        assert scan(src, data) == 0, "unchanged files skipped"
        assert collections(conn) == []
        with open(os.path.join(src, "note.txt"), "a", encoding="utf-8") as f:
            f.write(" thêm")
        assert scan(src, data, collection="vụ 1") == 1
        assert [tuple(r) for r in conn.execute(
            "SELECT text FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.name='note.txt'")] ==[("ghi chú thử nghiệm thêm",)], "re-index thay chunk cũ"
        assert collections(conn) == [{"collection": "vụ 1", "count": 1}]
        db.devices.insert_one({"case_name": "vụ 1", "name": "ĐT Nam", "type": "phone", "note": None, "created_at": now()})
        with open(os.path.join(src, "note.txt"), "a", encoding="utf-8") as f:
            f.write(".")
        assert scan(src, data, collection="vụ 1", device="ĐT Nam") == 1
        assert devices(conn, "vụ 1") == {"items": [{"name": "ĐT Nam", "type": "phone", "note": None,
                                                     "created_at": devices(conn, "vụ 1")["items"][0]["created_at"], "count": 1}],
                                          "unassigned": 0}, devices(conn, "vụ 1")
        assert list_files(conn, None, None, 1, 10, "vụ 1", "ĐT Nam")["total"] == 1
        assert list_files(conn, None, "ghi chú", 1, 10, "vụ 1", "khác")["total"] == 0
        assert scan(src, data, collection="vụ 1") == 0  # quét lại không đổi -> giữ device
        assert conn.execute("SELECT device FROM files WHERE name='note.txt'").fetchone()[0] == "ĐT Nam"
        assert list_files(conn, None, None, 1, 10, collection="vụ 1")["total"] == 1
        assert list_files(conn, None, "ghi chú", 1, 10, collection="khác")["total"] == 0
        ensure_case(conn, "vụ 2")
        ensure_case(conn, "vụ 2")  # idempotent
        c = {x["name"]: x for x in cases(conn)}
        assert c["vụ 1"]["count"] == 1 and c["vụ 1"]["by_kind"] == {"document": 1}, c
        assert c["vụ 2"]["count"] == 0 and c["vụ 2"]["by_kind"] == {} and c["vụ 2"]["note"] is None, c
        db.cases.delete_one({"name": "vụ 1"})  # vụ án chỉ còn trong files
        c = {x["name"]: x for x in cases(conn)}
        assert c["vụ 1"]["count"] == 1 and c["vụ 1"]["created_at"] == \
            conn.execute("SELECT MIN(indexed_at) FROM files WHERE collection='vụ 1'").fetchone()[0], c
        # DB bản cũ (không chunk, user_version 0): ảnh lấy chunk từ caption, tài liệu đánh dấu để scan lại
        conn.execute("DELETE FROM chunks")
        conn.execute("PRAGMA user_version=0")
        conn.commit()
        conn.close()
        conn = init_db(os.path.join(data, "index.db"))
        assert conn.execute("SELECT COUNT(*) FROM chunks WHERE source='image'").fetchone()[0] == 3
        assert scan(src, data) == 1 and conn.execute("SELECT COUNT(*) FROM chunks").fetchone()[0] == 4
        assert stats(conn)["errors"] == 0
        conn.close()

        # Office/csv: tạo docx/pptx/xlsx tối giản bằng zipfile
        office = os.path.join(tmp, "office")
        os.makedirs(office)
        def mkzip(name, entries):
            with zipfile.ZipFile(os.path.join(office, name), "w") as z:
                for n, x in entries.items():
                    z.writestr(n, x)
        W = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"'
        A = 'xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"'
        X = 'xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"'
        mkzip("a.docx", {"word/document.xml": f'<w:body {W}><w:p><w:r><w:t xml:space="preserve">Biên bản </w:t>'
                         '<w:t>khám&amp;xét</w:t></w:r></w:p><w:p><w:t>dòng</w:t><w:tab/><w:t>hai</w:t></w:p></w:body>'})
        mkzip("b.pptx", {"ppt/slides/slide10.xml": f"<a:p {A}><a:t>mười</a:t></a:p>",  # a:br tách số điện thoại
                         "ppt/slides/slide2.xml": f"<a:p {A}><a:t>Nguyen Van A</a:t><a:br/><a:t>0912345678</a:t></a:p>"})
        mkzip("c.xlsx", {
            "xl/workbook.xml": f'<workbook {X}><sheets><sheet name="Giao dịch" sheetId="1"/></sheets></workbook>',
            "xl/styles.xml": f'<styleSheet {X}><numFmts><numFmt numFmtId="165" formatCode="yyyy\\-mm\\-dd"/>'
                             '<numFmt numFmtId="166" formatCode="&quot;dd&quot; 0.00"/></numFmts>'
                             '<cellStyleXfs><xf numFmtId="14"/></cellStyleXfs><cellXfs><xf numFmtId="0"/>'
                             '<xf numFmtId="165"/><xf numFmtId="22"/><xf numFmtId="166"/><xf numFmtId="20"/></cellXfs></styleSheet>',
            "xl/sharedStrings.xml": f"<sst {X}><si><t>Nguyễn Văn A</t></si><si><r><t>điện </t></r><r><t>thoại</t></r></si></sst>",
            "xl/worksheets/sheet1.xml": f'<worksheet {X}><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1"><v>1500000.5</v></c>'
                                        '<c r="C1" t="inlineStr"><is><t>imei 3569</t></is></c></row><row r="2"/>'
                                        '<row r="5"><c r="A5" t="s"><v>1</v></c><c r="B5"><f>B1*2</f><v>3000001</v></c></row>'
                                        '<row r="6"><c s="1"><v>45352</v></c><c s="2"><v>45352.5</v></c><c s="3"><v>45352</v></c>'
                                        '<c s="4"><v>0.75</v></c><c s="0"><v>45352</v></c></row>'
                                        "</sheetData></worksheet>"})
        with open(os.path.join(office, "d.csv"), "w", encoding="utf-8") as f:
            f.write("tên;số tiền\nTrần B;250000\n\nLê C;-12,5\n")
        # #8 UTF-16 (BOM) csv; #5 ngoặc kép lệch + ô > 128 KB -> không csv.Error
        with open(os.path.join(office, "e.csv"), "w", encoding="utf-16") as f:
            f.write("số máy,ghi chú\n0987654321,gọi đêm\n")
        with open(os.path.join(tmp, "f.csv"), "w", encoding="utf-8") as f:
            f.write('a,"' + "y" * 200_000 + "\n")
        assert csv_units(os.path.join(office, "e.csv"))[1] == ("csv dòng 2", "csv dòng 2: 0987654321 | gọi đêm")
        assert len(csv_units(os.path.join(tmp, "f.csv"))[0][1]) > 200_000
        # #2 xlsx "<row>"*200000: expat tuyến tính (regex cũ: bậc hai, ~phút) -> nhanh, không treo
        bomb = os.path.join(tmp, "bomb.xlsx")
        with zipfile.ZipFile(bomb, "w", zipfile.ZIP_DEFLATED) as z:
            z.writestr("xl/worksheets/sheet1.xml", "<row>" * 200_000)
        t0 = datetime.now()
        assert office_units(bomb, "xlsx") == [] and (datetime.now() - t0).total_seconds() < 5
        with open(os.path.join(office, "bad.docx"), "wb") as f:
            f.write(b"not a zip")
        with open(os.path.join(office, "cu.doc"), "wb") as f:
            f.write(b"\xd0\xcf\x11\xe0 old doc")
        assert office_units(os.path.join(office, "a.docx"), "docx") == [(None, "Biên bản khám&xét\ndòng hai")]
        assert office_units(os.path.join(office, "b.pptx"), "pptx") == [("slide 2", "Nguyen Van A\n0912345678"), ("slide 10", "mười")]
        u = office_units(os.path.join(office, "c.xlsx"), "xlsx")
        assert u == [("Giao dịch dòng 1", "Giao dịch dòng 1: Nguyễn Văn A | 1500000.5 | imei 3569"),
                     ("Giao dịch dòng 5", "Giao dịch dòng 5: điện thoại | 3000001"),
                     ("Giao dịch dòng 6", "Giao dịch dòng 6: 2024-03-01 | 2024-03-01 12:00:00 | 45352 | 18:00:00 | 45352")], u
        assert csv_units(os.path.join(office, "d.csv")) == [
            ("csv dòng 1", "csv dòng 1: tên | số tiền"), ("csv dòng 2", "csv dòng 2: Trần B | 250000"),
            ("csv dòng 4", "csv dòng 4: Lê C | -12,5")], csv_units(os.path.join(office, "d.csv"))

        CONVERT_URL = "http://127.0.0.1:9"  # dịch vụ convert không chạy -> files.error, file khác vẫn xong
        os.environ["INDEX_WORKERS"] = "2"  # phần Office chạy 2 worker song song
        assert scan(office, data) == 7
        conn = init_db(os.path.join(data, "index.db"))
        for word, name in (("khám", "a.docx"), ("mười", "b.pptx"), ("0912345678", "b.pptx"), ("0987654321", "e.csv"), ("3569", "c.xlsx"), ("điện thoại", "c.xlsx")):
            assert [r["name"] for r in search(conn, [word])] == [name], word
        q = lambda sql, *a: [tuple(r) for r in conn.execute(sql, a)]
        assert q("SELECT c.loc, c.source FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid "
                 "WHERE chunks_fts MATCH '\"1500000\"'") == [("Giao dịch dòng 1", "text")]
        assert q("SELECT loc FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH 'muoi'") == [("slide 10",)]
        assert q("SELECT loc, text FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.name='d.csv'") == [
            ("csv dòng 1", "csv dòng 1: tên | số tiền\ncsv dòng 2: Trần B | 250000\ncsv dòng 4: Lê C | -12,5")]
        assert q("SELECT error FROM files WHERE name='bad.docx'")[0][0].startswith("BadZipFile")
        assert q("SELECT error FROM files WHERE name='cu.doc'")[0][0].startswith("URLError")
        CONVERT_URL = "http://convert"
        post = lambda url, body, timeout, lock: {"path": os.path.join(office, "a.docx")}  # giả convert: .doc -> a.docx
        assert scan(office, data) == 2, "bad.docx và cu.doc thử lại vì lỗi"
        assert q("SELECT error FROM files WHERE name='cu.doc'")[0][0] is None
        assert q("SELECT f.name FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid JOIN files f ON f.id=c.file_id "
                 "WHERE chunks_fts MATCH 'kham' ORDER BY 1") == [("a.docx",), ("cu.doc",)]
        assert scan(office, data) == 1, "chỉ còn bad.docx"
        conn.close()

        # audio/video: giả ASR; segments gộp ~1000 ký tự, loc HH:MM:SS của segment đầu đoạn
        media = os.path.join(tmp, "media")
        os.makedirs(media)
        with open(os.path.join(media, "a.wav"), "wb") as f:
            f.write(b"RIFF")
        segs = [{"start": 0.0, "end": 3, "text": " Anh Nam hẹn gặp. "}, {"start": 3.5, "end": 5, "text": "x" * 990},
                {"start": 3725.2, "end": 3730, "text": "chuyển khoản"}]
        post = lambda url, body, timeout, lock: {"language": "vi", "duration": 3730.0, "segments": segs}
        has_ff = shutil.which("ffmpeg")
        if has_ff:  # video 6 s: 3 s đỏ rồi 3 s xanh -> khung 0 s + khung đổi cảnh 3 s
            subprocess.run(["ffmpeg", "-v", "error", "-f", "lavfi", "-i", "color=red:s=320x240:d=3:r=10", "-f", "lavfi",
                            "-i", "color=blue:s=320x240:d=3:r=10", "-filter_complex", "[0][1]concat=n=2:v=1",
                            "-g", "5", os.path.join(media, "v.mp4")], check=True, timeout=60)
        assert scan(media, data) == (2 if has_ff else 1)
        conn = init_db(os.path.join(data, "index.db"))
        rows = q("SELECT loc, source, substr(text, 1, 12) FROM chunks c JOIN files f ON f.id=c.file_id "
                 "WHERE f.name='a.wav' ORDER BY seq")
        assert rows == [("00:00:00", "asr", "Anh Nam hẹn "), ("00:00:03", "asr", "x" * 12), ("01:02:05", "asr", "chuyển khoản")], rows
        assert q("SELECT loc FROM chunks_fts JOIN chunks c ON c.id=chunks_fts.rowid WHERE chunks_fts MATCH 'chuyen'") == [("01:02:05",)] * (2 if has_ff else 1)
        assert "Anh Nam hẹn gặp." in get_file(conn, q("SELECT id FROM files WHERE name='a.wav'")[0][0])["text_content"]
        if has_ff:
            v = get_file(conn, q("SELECT id FROM files WHERE name='v.mp4'")[0][0])
            assert v["error"] is None and (v["width"], v["height"]) == (320, 240) and os.path.isfile(os.path.join(data, v["thumb"])), v
            fr = q("SELECT loc FROM chunks WHERE file_id=? AND source='frame' ORDER BY seq", v["id"])
            assert fr == [("00:00:00",), ("00:00:03",)], fr
        conn.close()

        # pdf: trang trắng (không có chữ) -> render (tiến trình con) -> describe_image -> source 'ocr', loc "trang N"
        import pypdfium2 as pdfium
        pdf = pdfium.PdfDocument.new()
        pdf.new_page(595, 842)
        pdf.new_page(595, 842)
        pdf.save(os.path.join(tmp, "scan.pdf"))
        pdf.close()
        n = iter(range(9))  # #3: trang 2 mô tả lỗi -> bỏ trang đó, giữ trang 1
        flaky = types.SimpleNamespace(describe_image=lambda b: fake.describe_image(b) if next(n) != 1 else 1 / 0)
        fails = []
        assert pdf_chunks(os.path.join(tmp, "scan.pdf"), flaky, fails) == [("trang 1", "ocr", "ảnh thử nghiệm có xe máy\nHELLO")]
        assert fails == ["ZeroDivisionError: division by zero"]
        with open(os.path.join(tmp, "hong.pdf"), "wb") as f:
            f.write(b"%PDF-1.4 broken")
        try:
            pdf_chunks(os.path.join(tmp, "hong.pdf"), fake, [])
            raise AssertionError("pdf hỏng phải raise")
        except RuntimeError as e:
            assert "pdfium" in str(e), e

        # #1 symlink/FIFO bị bỏ; #3 video: ASR ok + khung 2 lỗi -> giữ transcript, error NULL; #6 collection giữ;
        # #7 ảnh EXIF Orientation=6 xoay đúng; #10 ảnh khai báo 7000x7000 bị từ chối; #12 id chunk không tái dùng
        ev = os.path.join(tmp, "ev")
        os.makedirs(ev)
        os.symlink("/proc/self/environ", os.path.join(ev, "notes.txt"))
        os.symlink("/dev/zero", os.path.join(ev, "a.jpg"))
        os.mkfifo(os.path.join(ev, "x.log"))
        im = Image.new("RGB", (400, 200), "red")
        exif = Image.Exif()
        exif[0x0112] = 6
        im.save(os.path.join(ev, "doc.jpg"), exif=exif)
        Image.new("1", (7000, 7000)).save(os.path.join(ev, "big.png"))
        if has_ff:
            shutil.copy(os.path.join(media, "v.mp4"), os.path.join(ev, "v.mp4"))
        k = iter(range(99))
        sys.modules["app.llm"].describe_image = lambda b: fake_d if next(k) != 2 else 1 / 0
        fake_d = {"caption": "c", "ocr_text": "o", "tags": []}
        assert scan(ev, data, collection="A") == (3 if has_ff else 2)
        conn = init_db(os.path.join(data, "index.db"))
        assert {r[0] for r in q("SELECT name FROM files WHERE path LIKE ?", ev + "%")} == \
            {"doc.jpg", "big.png"} | ({"v.mp4"} if has_ff else set())
        d = get_file(conn, q("SELECT id FROM files WHERE path=?", os.path.join(ev, "doc.jpg"))[0][0])
        assert (d["width"], d["height"]) == (200, 400) and Image.open(os.path.join(data, d["thumb"])).size == (160, 320), d
        assert "DecompressionBomb" in q("SELECT error FROM files WHERE path=?", os.path.join(ev, "big.png"))[0][0]
        if has_ff:
            vid = os.path.join(ev, "v.mp4")
            assert q("SELECT error, collection FROM files WHERE path=?", vid) == [(None, "A")]
            assert [r[0] for r in q("SELECT c.source FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path=? ORDER BY seq", vid)] \
                .count("asr") == 3
        max_id = q("SELECT MAX(id) FROM chunks")[0][0]
        with open(os.path.join(ev, "doc.jpg"), "ab") as f:
            f.write(b"\0")
        conn.execute("DELETE FROM chunks WHERE id=?", (max_id,))
        conn.commit()
        sys.modules["app.llm"].describe_image = lambda b: fake_d
        assert scan(ev, data) >= 1  # quét lại không có collection
        assert q("SELECT collection FROM files WHERE path=?", os.path.join(ev, "doc.jpg")) == [("A",)]
        assert q("SELECT MIN(c.id) FROM chunks c JOIN files f ON f.id=c.file_id WHERE f.path=?",
                 os.path.join(ev, "doc.jpg"))[0][0] > max_id, "AUTOINCREMENT: id mới, không tái dùng"
        conn.close()
    print("OK" + ("" if has_ff else " (bỏ qua video: không có ffmpeg)"))
