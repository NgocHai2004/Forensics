"""Truy hồi theo đoạn: FTS5 (bm25) + cosine embedding (Ollama bge-m3), gộp Reciprocal Rank Fusion.
Xem docs/CONTRACT-multimodal.md mục 4."""
import json
import logging
import math
import os
import re
import struct
import threading
import urllib.request

try:
    import numpy as np
except ImportError:  # ponytail: Python thuần chậm hơn nhiều, chỉ để vẫn chạy được khi thiếu numpy
    np = None

OLLAMA_URL = os.environ.get("OLLAMA_URL", "http://host.docker.internal:11434")
EMBED_MODEL = os.environ.get("EMBED_MODEL", "bge-m3")
log = logging.getLogger(__name__)
# ponytail: một câu hỏi quét vector tại một thời điểm (~4 KB/chunk trong RAM: 1M chunk ≈ 4 GB); nhiều người hỏi cùng lúc
# thì xếp hàng. Hết chỗ chờ -> sqlite-vec/ANN thay vì quét toàn bộ.
VEC_LOCK = threading.Semaphore(1)
JOIN = "FROM chunks c JOIN files f ON f.id = c.file_id"
COLS = ("c.id AS chunk_id, c.file_id, c.loc, c.source, c.text, "
        "f.name, f.kind, f.collection, f.taken_at, f.mtime, f.lat, f.lon")
# qwen viết "#12", "(#12)", "[#12@00:02:10]", "#12 @ trang 3"; loc chỉ nhận các dạng trong contract
CITE = re.compile(r"#(\d{1,18})(?:\s*@\s*(\d{1,2}:\d{2}(?::\d{2})?|(?:trang|slide) \d+|[^\]\)\n|@]+? dòng \d+))?", re.I)


def embed(texts):
    """-> list BLOB float32 little-endian đã chuẩn hóa L2 (cosine = dot). Lỗi mạng/Ollama -> raise."""
    req = urllib.request.Request(f"{OLLAMA_URL}/api/embed", json.dumps({"model": EMBED_MODEL, "input": texts}).encode(),
                                 {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=300) as r:
        vecs = json.load(r)["embeddings"]
    out = []
    for v in vecs:
        n = math.sqrt(sum(x * x for x in v)) or 1.0
        out.append(struct.pack(f"<{len(v)}f", *(x / n for x in v)))
    return out


def embed_pending(conn, batch=32):
    done = 0
    while rows := conn.execute("SELECT id, text FROM chunks WHERE embedding IS NULL LIMIT ?", (batch,)).fetchall():
        try:
            blobs = embed([r[1] or " " for r in rows])
        except Exception as e:  # Ollama tắt / thiếu model: lần scan sau embed tiếp
            log.warning("embed lỗi sau %d chunk: %s", done, e)
            return done
        conn.executemany("UPDATE chunks SET embedding=? WHERE id=?", [(b, r[0]) for b, r in zip(blobs, rows)])
        conn.commit()
        done += len(rows)
    return done


def search(conn, question, collection, k=30):
    # collection: None = mọi vụ án; str = một vụ án; list = các vụ án đó (list rỗng = không có gì)
    cols = [collection] if isinstance(collection, str) else collection
    where, args = (f"AND f.collection IN ({','.join('?' * len(cols))})", list(cols)) if cols is not None else ("", [])
    ranks = []
    words = [w for w in re.findall(r"\w+", question.lower()) if len(w) > 1][:30]
    if words:
        match = " OR ".join('"' + w.replace('"', '""') + '"' for w in words)
        ranks.append([r[0] for r in conn.execute(
            f"SELECT c.id FROM chunks_fts JOIN chunks c ON c.id = chunks_fts.rowid JOIN files f ON f.id = c.file_id "
            f"WHERE chunks_fts MATCH ? {where} ORDER BY bm25(chunks_fts) LIMIT 200", [match, *args])])
    try:
        q = embed([question])[0]
    except Exception as e:  # không có vector thì vẫn còn FTS
        log.warning("embed câu hỏi lỗi: %s", e)
    else:
        # ponytail: quét toàn bộ embedding trong RAM mỗi câu hỏi (~4 KB/chunk với bge-m3 1024 chiều);
        # ổn tới ~100k chunk, > 200k chunk thì cần sqlite-vec/ANN hoặc cache ma trận.
        with VEC_LOCK:
            rows = conn.execute(f"SELECT c.id, c.embedding {JOIN} WHERE length(c.embedding) = ? {where}",
                                [len(q), *args]).fetchall()
            if rows and np is not None:
                s = np.frombuffer(b"".join(r[1] for r in rows), "<f4").reshape(len(rows), -1) @ np.frombuffer(q, "<f4")
                ranks.append([rows[i][0] for i in np.argsort(-s)[:200]])
            elif rows:
                fmt = f"<{len(q) // 4}f"
                qv = struct.unpack(fmt, q)
                s = [sum(a * b for a, b in zip(qv, struct.unpack(fmt, r[1]))) for r in rows]
                ranks.append([rows[i][0] for i in sorted(range(len(rows)), key=s.__getitem__, reverse=True)[:200]])
            del rows
    score = {}
    for ids in ranks:
        for rank, i in enumerate(ids):
            score[i] = score.get(i, 0) + 1 / (60 + rank + 1)
    top = sorted(score, key=score.get, reverse=True)[:k]
    if not top:
        return []
    cur = conn.execute(f"SELECT {COLS} {JOIN} WHERE c.id IN ({','.join('?' * len(top))})", top)
    names = [d[0] for d in cur.description]
    rows = {r[0]: dict(zip(names, r)) for r in cur}
    return [rows[i] for i in top if i in rows]  # chunk bị xóa do re-index song song -> bỏ qua


def cite(answer, chunks, file_ids=()):
    """{file_id: loc} theo thứ tự trích lần đầu; chỉ nhận id có trong chunks/danh mục đã gửi (chống bịa id).
    loc = loc đầu tiên model ghi cho file đó, không có thì loc của chunk xếp hạng cao nhất của file."""
    best, locs = {}, set()
    for c in chunks:
        best.setdefault(c["file_id"], c["loc"])
        locs.add((c["file_id"], c["loc"]))
    for i in file_ids:
        best.setdefault(i, None)
    out = {}
    for m in CITE.finditer(answer):
        i = int(m[1])
        loc = m[2] if (i, m[2]) in locs else None  # model hay chép vị trí ví dụ trong prompt -> chỉ nhận loc có thật
        if i in best and not out.get(i):
            out[i] = loc
    return {i: loc or best[i] for i, loc in out.items()}


if __name__ == "__main__":
    _c = [{"file_id": 11, "loc": None}, {"file_id": 13, "loc": "00:00:10"}]
    assert cite("[#11@00:02:10] và [#13@00:00:10] và [#13@00:09:99]", _c) == {11: None, 13: "00:00:10"}, "loc bịa phải bị bỏ"
    import sqlite3

    conn = sqlite3.connect(":memory:")
    conn.executescript("""
    CREATE TABLE files(id INTEGER PRIMARY KEY, name TEXT, kind TEXT, collection TEXT, taken_at TEXT, mtime TEXT,
      lat REAL, lon REAL);
    CREATE TABLE chunks(id INTEGER PRIMARY KEY, file_id INTEGER NOT NULL, seq INTEGER NOT NULL, loc TEXT,
      source TEXT NOT NULL, text TEXT NOT NULL, embedding BLOB);
    CREATE VIRTUAL TABLE chunks_fts USING fts5(text, content='chunks', content_rowid='id',
      tokenize='unicode61 remove_diacritics 2');
    CREATE TRIGGER chunks_ai AFTER INSERT ON chunks BEGIN INSERT INTO chunks_fts(rowid, text) VALUES (new.id, new.text); END;
    INSERT INTO files VALUES (1,'clip.mp4','video','A',NULL,'2026-11-01T10:00:00',NULL,NULL),
      (2,'a.pdf','document','A',NULL,'2026-11-01T10:00:00',NULL,NULL), (3,'b.txt','document','B',NULL,'2026-11-01',NULL,NULL);
    """)
    v = lambda *x: struct.pack(f"<{len(x)}f", *x)
    conn.executemany("INSERT INTO chunks(id, file_id, seq, loc, source, text, embedding) VALUES (?,?,?,?,?,?,?)", [
        (1, 1, 0, "00:02:10", "asr", "anh Nam hẹn gặp chị Lan", v(1, 0, 0)),             # khớp cả FTS lẫn vector
        (2, 2, 0, "trang 3", "text", "biên bản thu giữ điện thoại", v(0.9, 0.436, 0)),  # chỉ gần về vector
        (3, 2, 1, "trang 4", "text", "Lan chuyển khoản", v(0, 0, 1)),                    # chỉ FTS ("lan")
        (4, 3, 0, None, "text", "Nam hẹn gặp Lan", v(1, 0, 0)),                           # vụ án khác
    ])
    embed = lambda texts: [v(1, 0, 0)]  # không gọi Ollama
    r = search(conn, "Nam hẹn gặp Lan ở đâu?", "A")
    assert [c["chunk_id"] for c in r][0] == 1 and {c["chunk_id"] for c in r} == {1, 2, 3}, r
    assert r[0]["name"] == "clip.mp4" and r[0]["loc"] == "00:02:10" and r[0]["collection"] == "A"
    assert 4 in [c["chunk_id"] for c in search(conn, "Nam hẹn gặp Lan", None)]
    assert search(conn, "", "B")[0]["chunk_id"] == 4  # câu hỏi rỗng: chỉ vector, vẫn lọc vụ án
    embed = lambda texts: 1 / 0  # Ollama lỗi -> chỉ FTS, không raise
    assert [c["chunk_id"] for c in search(conn, 'chuyển "khoản', "A")] == [3]
    conn.execute("UPDATE chunks SET embedding=NULL WHERE id=4")
    assert embed_pending(conn) == 0
    np = None  # nhánh Python thuần cho cùng kết quả
    embed = lambda texts: [v(1, 0, 0)] * len(texts)
    assert [c["chunk_id"] for c in search(conn, "Nam hẹn gặp Lan ở đâu?", "A")][0] == 1
    assert embed_pending(conn) == 1

    a = "Nam hẹn Lan [#1@00:02:10], (#2), #2 @ trang 4, [#99], #3@Sheet1 dòng 5, #1@trang 9 [#3]"
    assert cite(a, r) == {1: "00:02:10", 2: "trang 4"}, cite(a, r)  # #99 bịa, #3 không gửi -> bỏ
    assert cite("xem #2 @ trang 3 và [#7]", r, [7]) == {2: "trang 3", 7: None}
    assert cite("xem (#2) và #1", r) == {2: "trang 4", 1: "00:02:10"}  # không ghi loc -> chunk tốt nhất
    assert cite("[#3@Sheet1 dòng 5]", [{"file_id": 3, "loc": "Sheet1 dòng 5"}]) == {3: "Sheet1 dòng 5"}
    _x = [{"file_id": 5, "loc": "Giao dịch dòng 40"}, {"file_id": 5, "loc": "Giao dịch dòng 1"}]
    assert cite("theo [#5@Giao dịch dòng 40] và #5 @ Giao dịch dòng 1.", _x) == {5: "Giao dịch dòng 40"}
    assert CITE.search("(#5@Sổ phụ T11 dòng 7)")[2] == "Sổ phụ T11 dòng 7"

    def embed(texts):  # re-index song song: chunk 1 đã có trong hạng FTS rồi bị xóa trước SELECT cuối
        conn.execute("DELETE FROM chunks WHERE id=1")
        return [v(1, 0, 0)]
    assert 1 not in [c["chunk_id"] for c in search(conn, "Nam hẹn gặp Lan", "A")]
    print("retrieval OK")
