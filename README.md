# Mobile Forensic

Index thư mục chứng cứ (ảnh, video, ghi âm, Word/Excel/PowerPoint cũ và mới, PDF, txt/csv/json) thành các đoạn chữ có vị trí,
rồi hỏi đáp tiếng Việt bằng AI chạy hoàn toàn trên máy này. Câu trả lời trích nguồn dạng `[#id@vị trí]`
(giây của video/ghi âm, `trang N`, `slide N`, `Sheet dòng N`).

Máy chạy: `vibotics-laptop@100.96.177.83` (Ubuntu, RTX 5090 24 GB), thư mục `~/mobile-forensic`. Web: http://100.96.177.83:8000

## Kiến trúc

Docker Compose, 3 container, `restart: unless-stopped` (tự chạy lại khi lỗi hoặc reboot máy):

| service | container | việc | cổng |
|---|---|---|---|
| `fe` | `mf-fe` | nginx: giao diện React, chuyển `/api`, `/file`, `/thumb` sang be | 8000 (mở ra LAN) |
| `be` | `mf-be` | FastAPI: index, tìm kiếm, hỏi đáp; DB SQLite `data/index.db` | 8000 (chỉ mạng compose) |
| `ai` | `mf-ai` | faster-whisper large-v3 (GPU) giọng nói → chữ; LibreOffice doc/xls/ppt → docx/xlsx/pptx | 9001, 9002 (chỉ mạng compose) |
| — | `ollama` (dùng chung với AnythingLLM) | `qwen3-vl-32k` mô tả ảnh/khung hình + trả lời; `bge-m3` embedding | 11434 |

Luồng index (`app/indexer.py`): mỗi file → chữ → các đoạn ~1000 ký tự trong bảng `chunks` (+ FTS5) → embedding bge-m3.
- Ảnh: qwen3-vl mô tả + đọc chữ. Video: ASR + khung hình đổi cảnh (≤ 30) qua qwen3-vl. Ghi âm: ASR.
- Office cũ: convert rồi đọc như Office mới. Excel: theo dòng, giữ số, ngày ra ISO. PDF scan: render trang → qwen3-vl.

Luồng hỏi (`app/retrieval.py`, `app/main.py` `/api/ask`): FTS5 + cosine gộp RRF → ~30 đoạn → qwen3-vl trả lời
→ chỉ nhận trích dẫn trỏ tới đoạn đã gửi.

Contract chi tiết: `docs/CONTRACT-multimodal.md`. Tài liệu cũ: `docs/01`–`05`.

## Vận hành (SSH vào máy)

```bash
cd ~/mobile-forensic
docker compose ps                     # trạng thái 3 container
docker compose logs -f be             # log (fe / be / ai)
docker compose up -d --build          # triển khai code mới (chỉ build lại phần đổi)
docker compose up -d --build fe       # chỉ giao diện
docker compose restart ai             # khởi động lại một container
```

Container `ollama`, `anythingllm`, `n8n_*` không thuộc dự án: đừng restart/xóa.

Cấu hình: `.env` (chép từ `.env.example`, `chmod 600`) cho LLM; các biến còn lại nằm trong `docker-compose.yml`
(`INDEX_WORKERS`, `LLM_TEXT_BUDGET`, `EMBED_MODEL`, `ASR_URL`, `CONVERT_URL`). Tùy chọn: `UPLOAD_MAX_MB` (2048), `ASR_MAX_HOURS` (6).
Giới hạn RAM: app 6 GB, asr 12 GB, convert 4 GB.

Chứng cứ: `./sample` → `/evidence/sample`, `/mnt/casehdd16tb` → `/evidence/case` (chỉ đọc). Chỉ index được thư mục dưới
`/evidence` hoặc file tải lên (`data/uploads`). Dữ liệu: `data/` (index.db, thumbs, converted, models Whisper ~3 GB).

## Sự cố đã gặp

- **AI trả lời chậm 1–2 phút**: Ollama mất GPU, chạy CPU. Kiểm tra `docker exec ollama ollama ps` → cột PROCESSOR phải là `100% GPU`.
  Nếu là `CPU`: `docker restart ollama`.
- **File cũ chưa có đoạn**: DB từ bản trước được nâng cấp tự động; file chưa chia đoạn sẽ được index lại ở lần scan kế tiếp.
- Máy khởi động lại: dịch vụ chỉ tự lên nếu đã chạy `pm2 save && pm2 startup` (cần sudo, chưa làm).

## Kiểm tra

```bash
docker compose run --rm --no-deps app python -m app.indexer     # self-check indexer (in OK)
docker compose run --rm --no-deps app python -m app.retrieval   # self-check truy hồi (in retrieval OK)
python3 tests/smoke_ask.py                                      # app đang chạy: index sample + 7 câu hỏi thật
```

## Chưa có

Xác thực phía máy chủ (đăng nhập chỉ ở trình duyệt, đừng mở cổng 8000 ra Internet); trang Thiết bị Android / Ứng dụng /
Cloud / Phân tích là placeholder; chưa có parser DB chat (Zalo...); chưa dùng git.
