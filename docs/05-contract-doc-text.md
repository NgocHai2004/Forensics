# Contract: trích chữ tài liệu Office/PDF cho Hỏi đáp (2026-11-11)

## Vấn đề
- `indexer.index_one` chỉ đọc chữ của `TEXT_EXTS = {txt, md, csv, json, log}`. docx/xlsx/pptx/pdf có `text_content = NULL`, nên AI chỉ thấy tên file.
- `llm.answer` cắt `text_content` còn 500 ký tự mỗi file. Kể cả có chữ, AI cũng không tóm tắt được tài liệu dài.

## app/indexer.py (agent A)
1. Hằng số mới `EXTRACT_EXTS = {"docx", "xlsx", "pptx", "pdf"}`. Giới hạn chữ lưu mỗi file: `MAX_TEXT = 50000` ký tự (áp dụng cho cả TEXT_EXTS, thay 20000 cũ).
2. Hàm mới `extract_text(path, ext) -> str`:
   - docx: `word/document.xml`, cộng `word/header*.xml`, `word/footer*.xml`, `word/footnotes.xml` nếu có. Lấy chữ trong thẻ `w:t`, xuống dòng ở cuối mỗi `w:p`, tab ở `w:tab`.
   - pptx: `ppt/slides/slideN.xml` theo thứ tự số N tăng dần (không theo thứ tự chữ cái). Chữ trong `a:t`, xuống dòng cuối `a:p`. Mỗi slide bắt đầu bằng dòng `--- Slide N ---`.
   - xlsx: chữ trong `t` của `xl/sharedStrings.xml` và inline string trong `xl/worksheets/sheet*.xml`. Đủ cho tra cứu từ khóa; không cần dựng lại bảng.
   - pdf: `pypdf.PdfReader(path)`, `page.extract_text()` từng trang, dừng khi đủ MAX_TEXT. PDF mã hóa không mở được thì để exception bay lên.
   - Chỉ dùng stdlib (`zipfile`, `re` hoặc `xml.etree`, `html.unescape`) cho Office. `pypdf` là thư viện ngoài duy nhất, import bên trong nhánh pdf.
   - An toàn: không giải nén toàn bộ. Mỗi entry XML đọc tối đa 20 MB (`zf.open(name).read(20 << 20)`), tránh zip bomb. Không resolve entity ngoài.
   - Trả về chữ đã gộp khoảng trắng thừa trong dòng, cắt `MAX_TEXT`. Không có chữ thì trả `""` (không phải None).
3. `index_one`: nhánh `kind == "document"`:
   - ext trong TEXT_EXTS: như cũ, đọc tối đa MAX_TEXT.
   - ext trong EXTRACT_EXTS: `row["text_content"] = extract_text(path, ext)`. Exception (zip hỏng, pdf mã hóa...) → `row["error"] = "Type: msg"[:500]`, giống nhánh ảnh. Lỗi đó sẽ được thử lại ở lần scan sau như cơ chế hiện có.
4. Index lại dữ liệu cũ: điều kiện bỏ qua file không đổi phải KHÔNG bỏ qua hàng có `ext IN EXTRACT_EXTS AND text_content IS NULL`. Sau khi xử lý, text_content là chuỗi (có thể rỗng) nên không bị xử lý lại mãi.
5. Self-test `__main__`: thêm docx, pptx (có slide2 và slide10, kiểm slide 2 đứng trước slide 10), xlsx tạo bằng `zipfile` trong thư mục tạm; pdf có chữ nếu tạo được, không thì bỏ qua pdf có ghi chú. Kiểm `search()` tìm ra chữ bên trong; kiểm hàng cũ có text_content NULL được xử lý lại một lần rồi bị bỏ qua lần sau; kiểm zip hỏng ghi `error`. Giữ mọi assert cũ đúng (sửa số đếm nếu thêm file).

## app/llm.py (agent B)
1. Trong `answer()`, thay `[:500]` cố định bằng ngân sách chung:
   - `TEXT_BUDGET = 100000` ký tự cho toàn catalog.
   - `n` = số file trong catalog có `text_content` khác rỗng.
   - Mỗi file được `per_file = min(50000, max(500, TEXT_BUDGET // max(1, n)))` ký tự.
   - Vụ án ít tài liệu thì AI đọc được toàn bộ. Vụ án nhiều tài liệu thì mỗi file vẫn ít nhất 500 ký tự như cũ.
2. Giữ nguyên định dạng một dòng mỗi file và hàm `clean` (gộp xuống dòng, thay `|`). Không đổi chữ ký hàm, không đổi system prompt ngoài việc cần thiết.
3. Tách phép tính per_file thành hàm nhỏ test được không cần gọi API. Thêm assert offline vào `__main__` (trước phần gọi API) kiểm: 1 file dài 60000 → nhận 50000; 300 file → mỗi file 500.

## Lead
- `requirements.txt`: thêm `pypdf`.
- Sau khi tích hợp: chạy self-test hai file, review (ecc:python-reviewer, ecc:security-reviewer), deploy lên .96, gọi `POST /api/index` cho thư mục `/data/uploads/Vụ án 102` với collection `Vụ án 102` để file #12 có chữ.

## Ngoài phạm vi
- doc/xls/ppt đời cũ (định dạng nhị phân), PDF scan chỉ có ảnh (cần OCR). Các file này vẫn chỉ có tên và metadata.
