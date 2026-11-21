# CONTRACT v1 — Web "Folder Insight": index một thư mục media, dashboard, hỏi đáp

Mọi agent code theo file này, không theo nhau. Python 3.12, chỉ dùng: stdlib, fastapi, uvicorn, pillow, anthropic. Không thêm dependency.
Python trên máy: `C:\Users\rykud\AppData\Local\Programs\Python\Python312\python.exe` (gọi tắt `$PY`). Không có ffmpeg, không có GPU, không có Ollama.

## Layout

```
app/
  __init__.py        (rỗng)
  indexer.py         quét thư mục -> SQLite + thumbnail + gọi llm.describe_image
  llm.py             mọi lệnh gọi Claude nằm ở đây
  main.py            FastAPI, chạy: $PY -m uvicorn app.main:app --port 8000
  static/index.html  một trang, vanilla JS, không build
data/                runtime (gitignore): index.db, thumbs/<id>.jpg
```

## Env

| Biến | Mặc định | Ý nghĩa |
|---|---|---|
| `LLM_MODEL` | `claude-fable-5-1` | model duy nhất proxy hiện cho phép; `claude-opus-5-5`, `claude-sonnet-5-5`, `claude-haiku-5-5` bị 403 với key này |
| `MF_DATA` | `./data` | thư mục chứa index.db và thumbs/ |
| `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` | đã có sẵn trên máy | SDK tự đọc, code không đụng tới |

## SQLite schema (file `MF_DATA/index.db`, do `indexer.init_db` tạo, WAL mode)

```sql
CREATE TABLE IF NOT EXISTS files(
  id INTEGER PRIMARY KEY,
  path TEXT UNIQUE NOT NULL,     -- đường dẫn tuyệt đối
  name TEXT NOT NULL,
  ext TEXT NOT NULL,             -- chữ thường, không có dấu chấm
  kind TEXT NOT NULL,            -- image | video | audio | document | other
  size INTEGER NOT NULL,
  mtime TEXT NOT NULL,           -- ISO 8601 giờ local 'YYYY-MM-DDTHH:MM:SS'
  sha256 TEXT NOT NULL,
  taken_at TEXT,                 -- EXIF DateTimeOriginal dạng ISO, hoặc NULL
  lat REAL, lon REAL,            -- EXIF GPS, hoặc NULL
  width INTEGER, height INTEGER,
  caption TEXT,                  -- mô tả tiếng Việt do LLM sinh
  ocr_text TEXT,                 -- chữ nhìn thấy trong ảnh do LLM đọc
  tags TEXT,                     -- JSON array string, vd '["người","xe máy"]'
  text_content TEXT,             -- txt/md/csv/json/log: tối đa 20000 ký tự đầu
  thumb TEXT,                    -- 'thumbs/<id>.jpg' hoặc NULL
  indexed_at TEXT NOT NULL,
  error TEXT                     -- lỗi khi enrich (LLM, decode...) hoặc NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS files_fts USING fts5(
  name, caption, ocr_text, tags, text_content,
  content='files', content_rowid='id', tokenize='unicode61 remove_diacritics 2'
);
-- 3 trigger insert/update/delete giữ files_fts đồng bộ với files (mẫu chuẩn FTS5 external content)
CREATE TABLE IF NOT EXISTS index_runs(
  id INTEGER PRIMARY KEY,
  folder TEXT NOT NULL,
  started_at TEXT NOT NULL,
  finished_at TEXT,
  total INTEGER NOT NULL DEFAULT 0,
  done INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,          -- running | done | error
  message TEXT
);
```

Phân loại `kind` theo ext:
- image: jpg jpeg png gif webp bmp tif tiff heic heif
- video: mp4 mov mkv avi webm 3gp m4v
- audio: mp3 m4a wav aac ogg opus amr flac
- document: txt md csv json log pdf doc docx xls xlsx ppt pptx
- other: còn lại

## `app/llm.py` (owner: agent LLM)

```python
MODEL: str                      # os.environ.get("LLM_MODEL", "claude-fable-5-1")
class LLMError(Exception): ...  # bọc mọi lỗi SDK/parse; message ngắn, không traceback

def describe_image(jpeg_bytes: bytes) -> dict
    # vào: JPEG đã resize (cạnh dài <= 1024). Một lệnh gọi messages.create với image base64 media_type image/jpeg.
    # ra: {"caption": str (tiếng Việt, 1-3 câu), "ocr_text": str ("" nếu không có chữ), "tags": list[str] (3-10 từ khóa tiếng Việt, chữ thường)}
    # Yêu cầu model trả JSON thuần; parse bằng json.loads sau khi bỏ ``` fence nếu có. Lỗi -> raise LLMError.
    # Nếu stop_reason == "refusal": trả {"caption": "(model từ chối mô tả)", "ocr_text": "", "tags": []} không raise.

def extract_keywords(question: str) -> list[str]
    # 3-8 từ khóa tìm kiếm, cả tiếng Việt lẫn tiếng Anh, chữ thường, không dấu câu. Lỗi -> trả [] (không raise).

def answer(question: str, catalog: list[dict], history: list[dict]) -> str
    # catalog: danh sách dict từ indexer (các key: id, name, kind, taken_at, mtime, lat, lon, caption, ocr_text, tags, text_content). text_content cắt 500 ký tự trước khi đưa vào prompt.
    # history: tối đa 6 lượt gần nhất, mỗi phần tử {"role": "user"|"assistant", "content": str}.
    # Trả lời tiếng Việt, dựa HOÀN TOÀN vào catalog, mỗi khẳng định về file phải kèm [#<id>]. Không biết thì nói không tìm thấy trong dữ liệu.
    # Lỗi -> raise LLMError.
```

Quy ước SDK: `anthropic.Anthropic()` không tham số. `max_tokens=4000` cho describe/keywords, `16000` cho answer. Không dùng `thinking`, `temperature`, prefill, `tool_choice`. Luôn kiểm tra `stop_reason` trước khi đọc `content`.

## `app/indexer.py` (owner: agent INDEXER)

```python
def init_db(db_path: str) -> sqlite3.Connection
    # tạo thư mục cha, mở kết nối (check_same_thread=False, row_factory=sqlite3.Row), PRAGMA journal_mode=WAL, tạo schema ở trên.

def scan(folder: str, data_dir: str, progress=None) -> int
    # Mở kết nối riêng tới data_dir/index.db (hàm chạy trong thread nền, không dùng chung conn với FastAPI).
    # Ghi 1 dòng index_runs status=running. Duyệt đệ quy folder (os.walk), bỏ qua thư mục ẩn và file ẩn (bắt đầu bằng '.').
    # Với mỗi file: nếu đã có trong files cùng path, size, mtime -> bỏ qua. Ngược lại upsert theo path:
    #   - name, ext, kind, size, mtime, sha256 (đọc theo chunk 1MB), indexed_at
    #   - image: Pillow mở; width/height; EXIF DateTimeOriginal -> taken_at; GPS -> lat/lon (hàm dms_to_deg riêng);
    #            thumb 320px JPEG lưu data_dir/thumbs/<id>.jpg; JPEG cạnh dài 1024 (RGB, quality 85) -> llm.describe_image -> caption/ocr_text/tags(json.dumps ensure_ascii=False)
    #            LLMError hoặc lỗi decode -> ghi vào cột error, vẫn lưu dòng.
    #   - document với ext txt md csv json log: text_content = 20000 ký tự đầu (errors='replace'). pdf/doc/xlsx...: chỉ metadata.
    #   - video/audio/other: chỉ metadata (không có ffmpeg). Không caption.
    # progress(done, total) gọi sau mỗi file nếu có. Cập nhật index_runs.done định kỳ (mỗi 5 file) và cuối cùng status=done/finished_at; exception ngoài vòng lặp -> status=error, message.
    # Trả về số file đã xử lý (mới hoặc thay đổi).

def stats(conn) -> dict
    # {"total": int, "total_size": int, "by_kind": {"image": n, ...}, "by_month": [{"month": "YYYY-MM", "count": n}, ...] theo COALESCE(taken_at, mtime) sắp xếp tăng dần,
    #  "with_gps": n, "captioned": n, "errors": n, "last_run": dict hàng index_runs mới nhất hoặc None}

def search(conn, keywords: list[str], limit: int = 40) -> list[dict]
    # FTS5 MATCH với các keyword nối bằng OR, mỗi keyword đặt trong dấu nháy kép (escape nháy kép bên trong). Trả list dict đầy đủ cột files, sắp theo bm25.
    # keywords rỗng -> trả [] .

def list_files(conn, kind: str | None, q: str | None, page: int, limit: int) -> dict
    # {"items": [dict cột files], "total": int, "page": page, "limit": limit}. q khác None -> dùng search(conn, [q]) rồi lọc kind; else SELECT ORDER BY COALESCE(taken_at, mtime) DESC.

def get_file(conn, file_id: int) -> dict | None
```

## `app/main.py` (owner: agent API)

- `app = FastAPI()`. Startup: `DATA = Path(os.environ.get("MF_DATA", "./data")).resolve()`, `conn = indexer.init_db(str(DATA / "index.db"))`.
- Một `threading.Lock` + biến `current_thread` để chỉ cho phép 1 lần index chạy.

| Method | Path | Body / query | Trả về |
|---|---|---|---|
| GET | `/` | — | `static/index.html` (FileResponse) |
| GET | `/api/stats` | — | `indexer.stats(conn)` |
| GET | `/api/files` | `kind`, `q`, `page=1`, `limit=60` | `indexer.list_files(...)`; mỗi item thêm `thumb_url` (`/thumb/<id>` nếu có thumb, else null) và `file_url` (`/file/<id>`) |
| GET | `/api/files/{id}` | — | get_file + thumb_url/file_url, 404 nếu không có |
| POST | `/api/index` | `{"folder": str}` | 400 nếu folder không tồn tại hoặc không phải thư mục; 409 nếu đang chạy; else chạy `indexer.scan` trong `threading.Thread(daemon=True)` và trả `{"status": "started", "folder": <abs path>}` |
| GET | `/api/index/status` | — | hàng index_runs mới nhất dạng dict, hoặc `{"status": "idle"}` |
| POST | `/api/ask` | `{"question": str, "history": [{"role","content"}]}` | `{"answer": str, "sources": [{"id","name","kind","thumb_url","file_url","caption"}]}`. Logic: total = COUNT(files); nếu total <= 150 -> catalog = tất cả; else keywords = llm.extract_keywords(question) + các từ dài >= 3 ký tự trong câu hỏi, catalog = indexer.search(conn, keywords, 60); nếu rỗng -> 60 file mới nhất. answer = llm.answer(question, catalog, history[-6:]). sources = các file có `[#id]` xuất hiện trong answer (regex `\[#(\d+)\]`), giữ thứ tự xuất hiện, bỏ trùng. LLMError -> 502 với detail. |
| GET | `/file/{id}` | — | FileResponse(path từ DB); 404 nếu không có hoặc file đã bị xóa. Không nhận path từ client. |
| GET | `/thumb/{id}` | — | FileResponse(DATA/thumb); 404 nếu NULL |

Request body dùng pydantic BaseModel. Mọi câu trả lời JSON. Không CORS (cùng origin).

## `app/static/index.html` (owner: agent UI)

- Tiếng Việt. Sidebar trái 2 mục: **Dashboard**, **Hỏi đáp**. Vanilla JS, CSS inline, không CDN, không thư viện.
- Dashboard: ô nhập đường dẫn thư mục + nút "Index thư mục"; thanh tiến trình poll `/api/index/status` mỗi 2 giây khi running; 4 ô số (tổng file, dung lượng, đã mô tả, lỗi); bảng theo loại; biểu đồ cột theo tháng vẽ bằng div/CSS từ `by_month`; lưới thumbnail 60 file mới nhất, bộ lọc theo kind, ô tìm kiếm gọi `/api/files?q=`; click thumbnail mở `/file/<id>` tab mới và hiện caption.
- Hỏi đáp: khung chat, gửi `POST /api/ask` với `history` là các lượt trước (giữ trong biến JS, không localStorage); hiện answer (giữ xuống dòng), bên dưới là dải thumbnail `sources` click mở file; trạng thái "đang trả lời..."; lỗi 502 hiện message.
- Chạy ở width 360px không vỡ layout.

## Verify (mỗi agent tự chạy, lead chạy lại trên bản gộp)

- LLM: `$PY -c "from app import llm; print(llm.extract_keywords('ảnh nào có xe máy màu đỏ'))"` và describe_image trên một PNG sinh bằng Pillow.
- INDEXER: tạo thư mục tạm với 3 ảnh PNG sinh bằng Pillow + 1 file txt, monkeypatch `llm.describe_image` trả dict cố định, gọi scan rồi stats/search/list_files; assert số dòng, thumb tồn tại, FTS tìm được từ trong caption.
- API: `$PY -c "from app.main import app"` import không lỗi; chạy uvicorn và curl `/api/stats`, `/api/index/status`.
- UI: mở trong trình duyệt, không lỗi console khi API trả rỗng.
