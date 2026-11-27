// i18n tối giản: key = chuỗi tiếng Anh (mặc định). Bản VI là map ngược. Lưu lựa chọn vào localStorage.
import { createContext, useContext, useState } from 'react'
import type { ReactNode } from 'react'

const KEY = 'mf_lang'
const THEME_KEY = 'mf_theme'
export type Theme = 'dark' | 'light' | 'normal'

// từ khoá EN -> VI, chỉ cho các chuỗi GIAO DIỆN (label/button/tab/header). Dữ liệu (tên file, tên vụ) không dịch.
const VI: Record<string, string> = {
  'Collect USB / ADB': 'Thu thập USB / ADB',
  'Upload files': 'Tải lên tệp',
  'Package & Report': 'Đóng gói & Báo cáo',
  Devices: 'Thiết bị',
  Graph: 'Sơ đồ',
  'Evidence: ': 'Chứng cứ: ',
  'Artifacts: ': 'Loại dữ liệu: ',
  'All devices': 'Tất cả thiết bị',
  'All types': 'Tất cả loại',
  'Messages & Chats (CHAT)': 'Tin nhắn & Hội thoại (CHAT)',
  'Call logs (CALLS)': 'Nhật ký cuộc gọi (CALLS)',
  'Contacts (CONTACTS)': 'Danh bạ (CONTACTS)',
  'Images & Video (MEDIA)': 'Hình ảnh & Video (MEDIA)',
  'Documents & Logs': 'Tài liệu & Nhật ký',
  'All evidence': 'Toàn bộ chứng cứ',
  'Loading case data...': 'Đang nạp dữ liệu điều tra...',
  'Chat ID / Source': 'Chat ID / Nguồn',
  'Author / Sender': 'Author / Người gửi',
  'Recipient / Receiver': 'Recipient / Người nhận',
  'Message / Extracted text': 'Message / Nội dung trích xuất',
  Showing: 'Hiển thị',
  records: 'bản ghi',
  'Download original': 'Tải về tệp gốc',
  'Forensic Tags': 'Thẻ nghiệp vụ (Forensic Tags)',
  'Investigator notes': 'Ghi chú của điều tra viên',
  'Related profiles (Profiles)': 'Hồ sơ đối tượng liên đới (Profiles)',
  'Extracting: ': 'Đang trích xuất: ',
  'Android / iOS phone': 'Điện thoại Android / iOS',
  'HDD / USB drive': 'Ổ cứng / USB',
  'Camera DVR': 'Đầu thu Camera',
  'Laptop / PC': 'Laptop / Máy tính',
  Other: 'Khác',
  'Unassigned (Common evidence)': 'Không gán (Chứng cứ chung)',
  'Exported packages': 'Các gói chứng cứ đã xuất',
  'No packages created yet.': 'Chưa có gói chứng cứ nào được tạo.',
  Phone: 'Điện thoại',
  Connected: 'Kết nối',
  'No connection': 'Không kết nối',
  errors: 'lỗi',
  Unassigned: 'Không gán',
  // --- Subcategory (cây danh mục) ---
  'Zalo / OTT chat': 'Tin nhắn Zalo / OTT',
  'Outgoing call': 'Cuộc gọi đi',
  'Incoming call': 'Cuộc gọi đến',
  'Camera log': 'Nhật ký Camera',
  'Photos / Video': 'Ảnh chụp / Video',
  'Video recording': 'Video ghi hình',
  'Transaction log': 'Nhật ký giao dịch',
  'Documents & Notes': 'Tài liệu & Ghi chú',
  // --- Metadata keys ---
  'File name': 'Tên tệp',
  Size: 'Dung lượng',
  'Seized device': 'Thiết bị thu giữ',
  'Modified time': 'Thời gian sửa đổi',
  'SHA-256 hash': 'Mã băm SHA-256',
  'Original path': 'Đường dẫn tệp gốc',
  'AI description': 'Mô tả AI',
  'OCR text': 'Chữ nhận dạng OCR',
  Sender: 'Người gửi',
  Recipient: 'Người nhận',
  'Sent time': 'Thời gian gửi',
  'Message text': 'Nội dung tin nhắn',
  'Phone number': 'Số điện thoại',
  'Call direction': 'Hướng cuộc gọi',
  'Duration (s)': 'Thời lượng (giây)',
  Time: 'Thời gian',
  'Full name': 'Họ và tên',
  Email: 'Email',
  Resolution: 'Độ phân giải',
  'GPS coordinates': 'Tọa độ GPS',
  // --- author/recipient hằng ---
  'Device owner': 'Chủ máy',
  'Camera system': 'Hệ thống Camera',
  'Storage server': 'Máy chủ lưu trữ',
  Storage: 'Bộ nhớ lưu trữ',
  'E-wallet / Bank': 'Ví điện tử / Ngân hàng',
  'Device storage': 'Bộ nhớ máy',
  'Unassigned device': 'Chưa gán thiết bị',
  // --- chuỗi giao diện khác ---
  'No text preview available.': 'Không có nội dung văn bản xem trước.',
  Conversation: 'Luồng tin nhắn',
  General: 'Chung',
  'Cannot load case data': 'Không tải được dữ liệu vụ án',
  'Cannot start extraction': 'Không khởi động được trích xuất',
  'Starting...': 'Đang kích hoạt...',
  'Start collection': 'Bắt đầu thu thập',
  'Uploading...': 'Đang tải lên...',
  'Upload now': 'Tải lên ngay',
  'Creating...': 'Đang tạo...',
  Package: 'Đóng gói',
  'Enter new tag name...': 'Nhập tên thẻ mới...',
  'Note on behavior or evidence link...': 'Ghi chú đánh giá hành vi hoặc liên kết chứng cứ...',
  'e.g. Samsung Galaxy A52 (0987654321)': 'Ví dụ: Samsung Galaxy A52 (0987654321)',
  'Packaging note (e.g. Handover to prosecutor round 1)...': 'Ghi chú đóng gói (VD: Bàn giao Viện kiểm sát đợt 1)...',
  'Device name (e.g. iPhone 13 of Le Van C)...': 'Tên thiết bị (VD: iPhone 13 của Lê Văn C)...',
  'Sign out': 'Đăng xuất',
  FILTERS: 'BỘ LỌC',
  'Date: All': 'Ngày: Toàn bộ',
  'Tags: All': 'Thẻ: Tất cả',
  'Type a search term...': 'Nhập từ khoá tìm kiếm...',
  GO: 'TÌM',
  // --- nhãn cố định trước đây viết cứng tiếng Anh ---
  'FORENSIC INVESTIGATION': 'GIÁM ĐỊNH ĐIỀU TRA',
  'Artifacts Categories': 'Danh mục dữ liệu',
  Evidence: 'Chứng cứ',
  PREVIEW: 'XEM TRƯỚC',
  'DETAILS & ARTIFACT INFORMATION': 'CHI TIẾT & THÔNG TIN DỮ LIỆU',
  'Message Sent Date/Time': 'Thời gian gửi',
  'Time zone: GMT+7 (Hanoi, Bangkok)': 'Múi giờ: GMT+7 (Hà Nội, Băng Cốc)',
  'Column view': 'Dạng bảng',
  'Grid view': 'Dạng lưới ảnh',
  'Conversation view': 'Dạng hội thoại',
  'Phone contacts': 'Danh bạ điện thoại',
  'SMS / MMS': 'Tin nhắn SMS / MMS',
}

// Provider cấp lang + t(). EN là mặc định (trả đúng chuỗi code), VI tra bảng ngược.
export const I18nContext = createContext<{ lang: string; set: (l: string) => void; t: (k: string) => string; theme: Theme; setTheme: (m: Theme) => void; privacy: boolean; setPrivacy: (v: boolean) => void }>({
  lang: 'en', set: () => {}, t: (k) => k, theme: 'dark', setTheme: () => {}, privacy: false, setPrivacy: () => {},
})

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLang] = useState<string>(() => {
    try { return localStorage.getItem(KEY) || 'en' } catch { return 'en' }
  })
  const [privacy, setPrivacy] = useState(false)
  const [theme, setThemeState] = useState<Theme>(() => {
    try { const v = localStorage.getItem(THEME_KEY); return v === 'light' || v === 'normal' ? v : 'dark' } catch { return 'dark' }
  })
  const set = (l: string) => { setLang(l); try { localStorage.setItem(KEY, l) } catch {} }
  const setTheme = (m: Theme) => { setThemeState(m); try { localStorage.setItem(THEME_KEY, m) } catch {} }
  const t = (k: string) => (lang === 'vi' ? VI[k] ?? k : k)
  return <I18nContext.Provider value={{ lang, set, t, theme, setTheme, privacy, setPrivacy }}>{children}</I18nContext.Provider>
}

export function useI18n() {
  const { lang, set, t, theme, setTheme, privacy, setPrivacy } = useContext(I18nContext)
  return { lang, setLang: set, t, theme, setTheme, privacy, setPrivacy }
}