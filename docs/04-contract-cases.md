# CONTRACT — Vụ án (cases) làm đơn vị tổ chức

"Vụ án" = giá trị cột `files.collection`. Nhãn UI: dùng chữ **Vụ án** ở mọi nơi (thay "Bộ dữ liệu").

## Backend (owner BE) — `app/indexer.py`, `app/main.py`

SQLite (migration trong `init_db`, CREATE TABLE IF NOT EXISTS):
```sql
CREATE TABLE IF NOT EXISTS cases(
  name TEXT PRIMARY KEY,      -- = files.collection
  note TEXT,
  created_at TEXT NOT NULL    -- ISO 'YYYY-MM-DDTHH:MM:SS'
);
```
- `indexer.cases(conn) -> list[dict]`: `[{"name", "note", "created_at", "count", "by_kind": {kind: n}}]` = bảng cases LEFT JOIN đếm files theo collection, sắp theo created_at DESC. Vụ án có trong files nhưng chưa có trong cases cũng phải xuất hiện (count đúng, note NULL, created_at = MIN(indexed_at) của các file đó).
- `indexer.ensure_case(conn, name)`: `INSERT OR IGNORE INTO cases(name, created_at)`. Gọi trong `scan()` khi `collection` khác None (ngay đầu hàm, commit).
- `GET /api/cases` -> `indexer.cases(conn)`.
- `POST /api/cases` body `{"name": str, "note": str|null}` -> name qua `clean_name`, rỗng -> 400 "thiếu tên vụ án"; đã tồn tại -> 409 "vụ án đã tồn tại"; else insert và trả đúng một phần tử như trong `GET /api/cases` (count 0).
- `GET /api/collections` giữ nguyên (tương thích).
- `POST /api/ask` body thêm `collection: str|null = None`. Khi có: catalog chỉ gồm file có `collection` đó. Logic: `total = COUNT(*) WHERE collection=?`; total <= 150 -> `list_files(conn, None, None, 1, 150, collection)`; else keywords như cũ -> `indexer.search(conn, keywords, 1000)` lọc `r["collection"] == collection` lấy 60; rỗng -> `list_files(..., 1, 60, collection)`. Không có file nào trong vụ án -> 400 "vụ án chưa có tài liệu".
- `POST /api/upload` giữ nguyên, nhưng gọi `indexer.ensure_case(conn, collection)` trước khi start scan (để vụ án hiện ngay cả khi index còn chạy).

## Frontend chung — đã có trong `web/src/api.ts` (không sửa)
`Case {name, note, created_at, count, by_kind}`, `api.cases()`, `api.createCase(name, note?)`, `api.ask(question, history, collection?)`, `api.upload(files, collection)`, `api.files({collection,...})`, `api.indexStatus()`.

## Frontend A (owner FE-A) — `pages/Cases.tsx` (mới), `App.tsx`, `components/Shell.tsx`, `pages/Dashboard.tsx`, `pages/Settings.tsx`, `pages/Evidence.tsx`
- Shell NAV thêm mục **Vụ án** ngay sau Tổng quan: path `/cases`, icon `Briefcase`. App.tsx thêm route lazy `/cases` -> `pages/Cases`.
- `Cases.tsx`: tiêu đề "Vụ án"; form "Tạo vụ án mới" (input tên, input ghi chú tuỳ chọn, nút "Tạo vụ án"; lỗi 400/409 hiện inline, noValidate); lưới card mỗi vụ án: tên, ghi chú, ngày tạo (dd/mm/yyyy), tổng file, chip số theo loại (Ảnh/Video/Âm thanh/Tài liệu/Khác dùng `KIND_LABEL` từ `components/charts`), hai nút: "Hỏi đáp" -> `Link to={'/chat?case=' + encodeURIComponent(name)}`, "Chứng cứ" -> `/evidence?case=...`. Rỗng -> Empty "Chưa có vụ án".
- `Dashboard.tsx`: bỏ nút "+ Thu thập mới". Card "Nguồn dữ liệu" giữ nguyên.
- `Settings.tsx`: bỏ card "Tải tài liệu lên" và mọi state/hàm upload; đổi tiêu đề "Bộ dữ liệu hiện có" -> "Vụ án hiện có" dùng `api.cases()` (tên + số file), thêm nút/link "Quản lý vụ án" -> `/cases`. Giữ "Tiến trình index" và "Thông tin hệ thống". Layout 2 cột đều nhau.
- `Evidence.tsx`: nhãn select "Vụ án" / option đầu "Tất cả vụ án", đọc `?case=` từ `useSearchParams` để chọn sẵn.

## Frontend B (owner FE-B) — `pages/Chat.tsx`
- Đọc `?case=` từ `useSearchParams`; khi chọn vụ án thì cập nhật query (`setSearchParams({case})`).
- Cột trái: tiêu đề "Vụ án", nút "Tạo vụ án mới" (bấm ra input tên inline + nút Tạo, gọi `api.createCase`, lỗi inline), danh sách vụ án từ `api.cases()` (tên + số file), vụ án đang chọn nổi bật (`aria-current`). < 768px: `<select>`.
- Chưa chọn vụ án: giữa hiện Empty "Chọn vụ án để bắt đầu" và textarea + nút Gửi `disabled`.
- Hội thoại lưu theo vụ án: `Record<caseName, {messages, sources, error}>` trong state; đổi vụ án thì hiện hội thoại của vụ đó. Gửi: `api.ask(q, history, caseName)`. Lỗi 400 "vụ án chưa có tài liệu" hiện như bong bóng lỗi kèm gợi ý "Thêm tài liệu ở cột Chi tiết".
- Cột phải "Chi tiết" (vụ án đang chọn): tên vụ án + chip số file theo loại (từ `api.cases()`), nút **"Thêm tài liệu"** mở vùng kéo thả (label bọc input file multiple, danh sách file chọn với nhãn loại, nút "Tải lên"), gọi `api.upload(files, caseName)`, rồi poll `api.indexStatus()` mỗi 2 s khi running và hiện thanh tiến trình; xong thì tải lại `api.cases()` và danh sách tài liệu. Bên dưới: danh sách tài liệu của vụ án `api.files({collection: caseName, limit: 50})` (icon theo loại + tên, click mở file_url). Cuối: sources của câu trả lời mới nhất như cũ. Ở < 1280px vẫn là drawer.
- Giữ nền ảnh `/chat-bg.png` và style hiện tại (khung giữa trong suốt, khung bên `bg-white/80!`).

## Verify
- BE: `python -m app.indexer` OK; TestClient script: tạo vụ án rỗng -> GET /api/cases có count 0; upload 2 file vào vụ án đó -> count 2 và by_kind đúng; vụ án trùng -> 409; ask với collection của vụ án rỗng -> 400; ask với collection có file -> 200 (fake llm); vụ án chỉ có trong files (scan với collection không qua POST /api/cases) vẫn xuất hiện trong GET /api/cases.
- FE: `npx tsc -p tsconfig.app.json --noEmit` sạch, `npx vite build` pass.
