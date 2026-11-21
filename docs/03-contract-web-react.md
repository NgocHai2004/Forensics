# CONTRACT — Frontend React + Tailwind "Mobile Forensic" (thay thế app/static/index.html)

Mọi agent code theo file này. Stack đã cài trong `web/`: Vite 8, React 19, TypeScript, Tailwind v4 (`@tailwindcss/vite`), react-router-dom 7, recharts 3, lucide-react. **Không thêm dependency.**
Backend giữ nguyên: FastAPI `app/main.py` (xem `docs/02-contract-web-v1.md`). Dev: `npm run dev` ở `web/` proxy sang :8000.

## Đã có sẵn (không sửa)

- `web/src/index.css`: token màu/font trong `@theme`. Dùng class Tailwind: `bg-primary`, `bg-primary-hover`, `bg-primary-soft`, `text-navy`, `text-ink`, `text-muted`, `border-line`, `bg-canvas`, `bg-card`, `text-success`, `text-warning`, `text-danger`, `bg-ai`, `bg-ai-soft`, `font-display`, utility `card` (nền trắng, viền, bo 12px, bóng nhẹ).
- `web/src/api.ts`: `api.stats()`, `api.files({kind,q,page,limit})`, `api.file(id)`, `api.startIndex(folder)`, `api.indexStatus()`, `api.ask(question, history)`, kiểu `Stats`, `FileItem`, `IndexRun`, `ChatMsg`, `Source`, `AskResult`, `ApiError`, `fmtSize`.

## Cây file và owner

```
web/src/
  main.tsx                 A  BrowserRouter + <App/>
  App.tsx                  A  Routes, RequireAuth, lazy pages
  auth.ts                  A  getUser()/login(name)/logout() — sessionStorage key 'mf_user' (chưa có backend auth)
  components/Shell.tsx     A  sidebar + topbar + <Outlet/>
  components/Logo.tsx      A  shield + fingerprint SVG, chữ MOBILE FORENSIC (navy, teal)
  components/Empty.tsx     A  empty-state (icon, tiêu đề, mô tả)
  pages/Login.tsx          A
  pages/Placeholder.tsx    A  "Module <tên> chưa triển khai trong v1" dùng Empty
  pages/Dashboard.tsx      B
  pages/Evidence.tsx       B  lưới file thật (lọc kind, tìm kiếm, phân trang)
  pages/Settings.tsx       B  form index thư mục + tiến trình
  components/charts.tsx    B  AreaChart tháng + Donut phân loại (recharts)
  pages/Chat.tsx           C  3 cột: hội thoại | chat | chi tiết
```

Owner A/B/C chỉ ghi file của mình. B và C KHÔNG import từ nhau, chỉ import `api.ts`, `components/Empty.tsx`, và (B) `components/charts.tsx`. A phải tạo `Empty.tsx` với đúng chữ ký dưới đây; B, C code theo chữ ký đó.

```tsx
// components/Empty.tsx
export default function Empty(props: { icon: React.ComponentType<{ className?: string }>; title: string; desc?: string; action?: React.ReactNode }): JSX.Element
```

## Routes (App.tsx, owner A)

| Path | Page | Sidebar label | Icon (lucide) |
|---|---|---|---|
| `/login` | Login | — | — |
| `/` | Dashboard | Tổng quan | Home |
| `/devices` | Placeholder "Thiết bị Android" | Thiết bị Android | Smartphone |
| `/apps` | Placeholder "Ứng dụng" | Ứng dụng | LayoutGrid |
| `/cloud` | Placeholder "Cloud" | Cloud | Cloud |
| `/evidence` | Evidence | Chứng cứ | FileText |
| `/analysis` | Placeholder "Phân tích" | Phân tích | PieChart |
| `/chat` | Chat | AI Hỏi đáp | Sparkles |
| `/settings` | Settings | Cài đặt | Settings |

Mọi route trừ `/login` bọc trong `RequireAuth` (không có user -> `<Navigate to="/login" replace/>`) và `Shell`. Dùng `React.lazy` + `Suspense` cho pages. Route không khớp -> `/`.

## Shell (A) — theo mockup 2

- Sidebar trái 232px, nền trắng, viền phải `border-line`. Logo trên cùng. Nav: mỗi item `NavLink` cao 40px, icon 18px + label, active = `bg-primary-soft text-navy font-semibold` + thanh dọc 3px màu `primary` bên trái; hover `bg-canvas`. Dưới cùng: tên user + nút Đăng xuất.
- Topbar cao 56px, nền trắng, viền dưới: trái = tiêu đề trang (lấy từ route), phải = chấm xanh `success` + "Trực tuyến", avatar tròn + "ĐTV <tên user>".
- `<main className="p-6 bg-canvas min-h-[calc(100vh-56px)]"><Outlet/></main>`.
- < 1024px: sidebar ẩn, nút hamburger ở topbar mở sidebar dạng overlay (đóng khi chọn route hoặc Esc). Không scroll ngang ở 375px.

## Login (A) — theo mockup 1

Nền `bg-canvas` với lưới chấm/đường mờ vẽ bằng CSS (radial-gradient hoặc SVG inline, opacity thấp). Card trắng 360px giữa màn: Logo lớn, input "Tên đăng nhập" (icon User) có `<label>` (sr-only cũng được nhưng phải có), input "Mật khẩu" (icon Lock, nút hiện/ẩn với aria-label), checkbox "Xác thực 2 yếu tố (2FA)", nút "ĐĂNG NHẬP" full width `bg-primary`, dòng "HỆ THỐNG TRUY CẬP HẠN CHẾ" chữ nhỏ muted. Submit: bắt buộc nhập cả hai, gọi `login(name)` rồi `navigate('/')`. Lỗi hiện ngay dưới field. Ghi chú nhỏ: "Bản v1 chưa xác thực với máy chủ".

## Dashboard (B) — theo mockup 2, dùng dữ liệu thật từ `api.stats()`

- Hàng tiêu đề: "Dashboard" + nút `bg-primary` "+ Thu thập mới" (link tới `/settings`).
- 4 stat card (grid 4 cột, 2 cột ở < 1024px, 1 cột ở < 640px): "Tổng file" = total, "Dung lượng" = fmtSize(total_size), "Đã mô tả" = captioned, "Lỗi" = errors. Số dùng `font-display text-2xl`.
- Hàng 2: card "Tiến trình thu thập" (AreaChart từ `by_month`, chiếm 2/3) + card "Nguồn dữ liệu" (1/3): v1 chưa có thiết bị -> hiển thị `last_run` dạng một dòng: tên = folder basename, thanh tiến trình done/total với %, trạng thái; nếu `last_run` null -> Empty "Chưa có nguồn dữ liệu" + link `/settings`.
- Hàng 3: card "Phân loại dữ liệu" (Donut từ `by_kind`, legend bên phải: Ảnh, Video, Âm thanh, Tài liệu, Khác) + card "Hoạt động gần đây": 5 file mới nhất từ `api.files({limit:5})` dạng "HH:MM – <name> (<kind>)" link tới `/evidence`.
- Loading: skeleton `animate-pulse`. Lỗi: dòng `text-danger`.

## charts.tsx (B) — gọi skill `dataviz` trước khi viết

```tsx
export function MonthArea(props: { data: { month: string; count: number }[] }): JSX.Element   // ResponsiveContainer, AreaChart, stroke primary, fill primary 15%, trục tháng 'MM/YY', tooltip tiếng Việt
export function KindDonut(props: { data: Partial<Record<Kind, number>> }): JSX.Element          // PieChart innerRadius, 5 màu có thứ tự cố định, legend custom có số, tổng ở giữa
```

Màu theo kind cố định: image `#14919b`, video `#0f7a83`, audio `#7fd1d6`, document `#a7c7e7`, other `#cbd5e1`. Mọi chart có `role="img"` + `aria-label` mô tả dữ liệu.

## Evidence (B)

- Thanh trên: chip lọc kind (Tất cả/Ảnh/Video/Âm thanh/Tài liệu/Khác) + ô tìm kiếm (Enter hoặc nút) gọi `api.files({kind,q,page,limit:48})`.
- Lưới thumbnail `grid-cols-[repeat(auto-fill,minmax(140px,1fr))]`; tile không có thumb -> ô xám với ext viết hoa + icon theo kind. Click tile mở panel bên phải (hoặc dưới ở mobile) hiện: ảnh lớn (nếu có), name, kind, size, mtime, taken_at, lat/lon, caption, ocr_text, tags (chip), text_content (pre, cắt 2000), error (`text-danger`), nút "Mở file gốc" (`file_url`, target _blank).
- Phân trang: "Trang x/y" + Trước/Sau. Rỗng -> Empty.

## Settings (B)

Card "Thu thập từ thư mục": input đường dẫn (có label), nút "Bắt đầu index" (`api.startIndex`), lỗi 400/409 hiện dưới input, thanh tiến trình poll `api.indexStatus()` mỗi 2s khi `running` rồi dừng, hiển thị done/total, trạng thái done/error với message. Card thứ hai "Thông tin hệ thống": model LLM (chữ "claude-fable-5-1 qua proxy"), giới hạn v1 (video/audio chỉ metadata).

## Chat (C) — theo mockup 3

- Layout 3 cột ở ≥ 1280px: trái 240px (danh sách hội thoại), giữa linh hoạt, phải 260px (Chi tiết). < 1280px: ẩn cột phải vào nút "Chi tiết" mở drawer; < 768px: cột trái thành dropdown chọn hội thoại.
- Hội thoại lưu trong `useState` (mảng `{id, title, messages: ChatMsg[], sources: Source[]}`), nút "Cuộc trò chuyện mới (+)". Title = 40 ký tự đầu câu hỏi đầu tiên. Không localStorage.
- Giữa: bong bóng user phải (`bg-ai-soft text-ink`, avatar "ĐTV"), bong bóng AI trái (`bg-canvas`, avatar icon Sparkles trong vòng tròn `bg-primary-soft`, nhãn "Cyber AI"). Nội dung answer render dạng text giữ xuống dòng (`whitespace-pre-wrap`), KHÔNG dangerouslySetInnerHTML; các mẫu `[#123]` trong answer biến thành nút nhỏ `bg-primary-soft` mở `file_url` tương ứng nếu có trong sources. Dưới bong bóng AI: dải thumbnail sources (ảnh hoặc ô ext).
- Gợi ý nhanh dưới câu trả lời: 2 chip "Tóm tắt các file có chữ" và "Liệt kê file theo thời gian" -> điền vào ô nhập.
- Ô nhập dưới cùng: textarea 1-4 dòng tự giãn, placeholder "Hỏi AI về dữ liệu điều tra...", nút "Gửi" `bg-primary` (Enter gửi, Shift+Enter xuống dòng), disabled khi đang chờ; trạng thái "đang trả lời..." với 3 chấm nhấp nháy; lỗi `ApiError` hiện bong bóng `text-danger`.
- Cột phải "Chi tiết": sources của câu trả lời mới nhất (icon theo kind + name, click mở file); bên dưới "Thống kê" từ `api.stats()` (tổng file, đã mô tả). Không có đối tượng/NER trong v1 -> không bịa.

## Chung

- Không emoji làm icon; chỉ lucide-react. Mọi nút icon-only có `aria-label`. Kích thước chạm tối thiểu 40px. Hover/transition 150-200ms. Không dùng màu làm tín hiệu duy nhất (kèm chữ).
- Không `any`. Không fetch ngoài `api.ts`. Không thư viện mới.
- Verify của mỗi agent: `cd web && npx tsc -p tsconfig.app.json --noEmit` và `npx vite build` phải pass (B, C có thể thiếu file của A lúc build; khi đó chỉ chạy tsc trên file của mình bằng cách tạm tạo stub `Empty.tsx` nếu chưa có, nhưng KHÔNG commit stub vào repo nếu A đã tạo).
