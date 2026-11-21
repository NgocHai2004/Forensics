# Contract: đa định dạng + hỏi đáp theo đoạn (máy .83, ~/mobile-forensic)

Máy chạy duy nhất: vibotics-laptop@100.96.177.83, thư mục ~/mobile-forensic. Không dùng repo Windows.
Compose project "mobile-forensic". 3 service, mỗi service là 1 tiến trình pm2 (lead lo pm2 + docker-compose.yml):

| service | container | cổng nội bộ | owner |
|---|---|---|---|
| app     | mobile-forensic | 8000 (publish 8000) | Agent C (indexer) + Agent D (hỏi đáp) |
| asr     | mf-asr          | 9001 (KHÔNG publish) | Agent A |
| convert | mf-convert      | 9002 (KHÔNG publish) | Agent B |

Volume giống nhau ở cả 3: ./data:/data (asr chỉ đọc), ./sample:/evidence/sample:ro, /mnt/casehdd16tb:/evidence/case:ro.
Ollama (container "ollama", dùng chung với anythingllm) ở http://host.docker.internal:11434, KHÔNG được restart/xóa nó.

## 1. ASR service (Agent A)
POST http://asr:9001/transcribe  body {"path": "/evidence/... hoặc /data/..."}  (file audio HOẶC video bất kỳ)
→ 200 {"language": "vi", "duration": 123.4, "segments": [{"start": 0.0, "end": 3.2, "text": "..."}]}
→ 400 {"detail": "..."} path không tồn tại/không nằm dưới /evidence hoặc /data; 422 không giải mã được.
File không có tiếng (video câm) → 200 với segments [].
GET http://asr:9001/health → {"ok": true, "device": "cuda"}
Phục vụ tuần tự (1 model, khóa toàn cục). Tối đa 1 file/lần; app gọi với timeout 1800 s.

## 2. Convert service (Agent B)
POST http://convert:9002/convert body {"path": "<file .doc/.xls/.ppt/.rtf/.odt/.ods/.odp>"}
→ 200 {"path": "/data/converted/<sha256 của file gốc>.<docx|xlsx|pptx>"}  (có rồi thì trả luôn, không convert lại)
→ 400 path sai/đuôi không hỗ trợ; 422 LibreOffice lỗi. Timeout convert 120 s.
GET http://convert:9002/health → {"ok": true}

## 3. Bảng chunks trong /data/index.db (Agent C tạo trong indexer.init_db, Agent D đọc)
CREATE TABLE IF NOT EXISTS chunks(
  id INTEGER PRIMARY KEY,
  file_id INTEGER NOT NULL,          -- files.id
  seq INTEGER NOT NULL,              -- thứ tự trong file
  loc TEXT,                          -- "00:02:10" (audio/video, giây bắt đầu, HH:MM:SS) | "trang 3" | "slide 4" | "Sheet1 dòng 5" | NULL
  source TEXT NOT NULL,              -- 'text' | 'asr' | 'frame' | 'image' | 'ocr'
  text TEXT NOT NULL,                -- ~300–1500 ký tự
  embedding BLOB                     -- float32 little-endian; NULL = chưa embed (Agent D điền)
);
CREATE INDEX IF NOT EXISTS chunks_file ON chunks(file_id);
+ FTS5 external content: chunks_fts(text) content='chunks' content_rowid='id' với trigger ai/ad/au như files_fts.
Re-index một file: xóa mọi chunks của file_id đó rồi insert lại (embedding NULL).
files.text_content vẫn được điền (toàn văn/transcript, cắt MAX_TEXT) để Dashboard/Evidence dùng như cũ.

Quy tắc tạo chunk theo loại (Agent C):
- image: 1 chunk source='image', loc NULL, text = caption + "\n" + ocr_text.
- audio: segments ASR gộp thành đoạn ~1000 ký tự, source='asr', loc = start của segment đầu đoạn (HH:MM:SS).
- video: ASR như audio + khung hình (ffmpeg chọn cảnh, tối đa 30 khung, cách nhau ≥ 2 s) → llm.describe_image → 1 chunk/khung source='frame',
  loc = thời điểm khung; text = "[khung hình] caption | chữ: ocr". Khung đầu tiên làm thumbnail (files.thumb).
- docx/pdf/pptx/txt/md/json/log: tách ~1000 ký tự; pdf loc "trang N", pptx loc "slide N", còn lại loc NULL. source='text'.
- pdf trang không có chữ (scan): render trang (pypdfium2) → llm.describe_image → source='ocr', loc "trang N" (tối đa 50 trang/file).
- xlsx/csv: mỗi dòng thành "Sheet1 dòng 5: ô1 | ô2 | ...", gộp nhiều dòng ~1000 ký tự, loc = "Sheet1 dòng <đầu đoạn>"; giữ cả số, không chỉ chuỗi.
- doc/xls/ppt/rtf/odt/ods/odp: gọi convert → xử lý file kết quả như docx/xlsx/pptx (files.path vẫn là file gốc).
- Dịch vụ asr/convert không gọi được → files.error ghi lỗi (scan sau thử lại), không làm chết cả scan.
Env của app: ASR_URL=http://asr:9001, CONVERT_URL=http://convert:9002.

## 4. Embedding + truy hồi (Agent D, file mới app/retrieval.py)
retrieval.embed_pending(conn, batch=32) -> int   # embed mọi chunk embedding IS NULL qua Ollama /api/embed, model env EMBED_MODEL (mặc định "bge-m3"); trả số chunk đã embed. Ollama lỗi -> log + trả số đã làm, không raise.
retrieval.search(conn, question: str, collection: str | None, k: int = 30) -> list[dict]
   mỗi dict: chunk_id, file_id, loc, source, text, name, kind, collection, taken_at, mtime, lat, lon
   = kết hợp FTS5 (chunks_fts, bm25) + cosine trên embedding (numpy không có thì Python thuần), gộp bằng Reciprocal Rank Fusion.
Agent C gọi retrieval.embed_pending(conn) MỘT lần ở cuối indexer.scan() (try/except, lỗi chỉ log).
Trích dẫn trong câu trả lời: [#<file_id>@<loc>] hoặc [#<file_id>] khi loc NULL.
/api/ask trả: {"answer": str, "sources": [{"id","name","kind","thumb_url","file_url","caption","loc"}]}
   loc dạng thời gian → web mở file_url + "#t=<giây>" (media fragment); "trang N" của pdf → "#page=N".
