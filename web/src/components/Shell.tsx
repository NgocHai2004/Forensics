import { Suspense, useEffect, useState } from 'react'
import { Link, NavLink, Outlet, useLocation, useMatch, useNavigate } from 'react-router-dom'
import { Briefcase, ChevronRight, FileText, Home, LogOut, Network, Settings } from 'lucide-react'
import Logo from './Logo'
import { getUser, logout } from '../auth'
import { api } from '../api'

export const NAV = [
  { path: '/', label: 'Tổng quan', icon: Home },
  { path: '/cases', label: 'Vụ án', icon: Briefcase },
  { path: '/graph', label: 'Sơ đồ các vụ án', icon: Network },
  { path: '/settings', label: 'Cài đặt', icon: Settings },
  // không có trong menu (đã gộp vào trang vụ án), vẫn mở được từ nút "Chứng cứ" -> giữ để topbar hiện đúng tên
  { path: '/evidence', label: 'Chứng cứ', icon: FileText, hidden: true },
  { path: '/chat', label: 'Hỏi đáp', icon: FileText, hidden: true },
]

// Menu dạng thanh icon hẹp: rê chuột / Tab tới icon thì hiện nhãn bên phải
const TIP = 'pointer-events-none absolute left-full top-1/2 z-40 ml-3 -translate-y-1/2 whitespace-nowrap rounded-md bg-navy px-2.5 py-1 text-xs font-medium text-white opacity-0 shadow-md transition-opacity duration-150 group-hover:opacity-100 group-focus-visible:opacity-100'
const ITEM = 'group relative flex h-11 w-11 items-center justify-center rounded-xl transition-colors duration-150'

export default function Shell() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const user = getUser() ?? ''
  const caseName = useMatch('/cases/:name')?.params.name
  const title = NAV.find((n) => n.path === pathname || (n.path !== '/' && pathname.startsWith(n.path + '/')))?.label ?? 'Tổng quan'
  // Đếm thiết bị đang kết nối (điện thoại ADB + USB) hiển thị trên header sau đăng nhập.
  const [conn, setConn] = useState<{ n: number; bad: number }>({ n: 0, bad: 0 })
  useEffect(() => {
    const tick = () => Promise.all([api.phoneStatus().catch(() => null), api.usb().catch(() => null)])
      .then(([ph, usb]) => {
        const phones = ph?.devices ?? []
        // usb.items gồm điện thoại + ổ cứng + camera... đã phân loại; điện thoại ADB luôn cắm USB nên không đếm trùng.
        setConn({ n: usb?.items.length ?? 0, bad: phones.filter(d => d.state !== 'device').length })
      })
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  return (
    <div className="flex min-h-screen">
      <aside className="sticky top-0 z-30 flex h-screen w-16 shrink-0 flex-col items-center border-r border-line bg-white">
        <Link to="/" aria-label="Forensic Investigation - Tổng quan" className="flex h-14 w-full shrink-0 items-center justify-center border-b border-line">
          <Logo mark />
        </Link>
        <nav className="flex flex-1 flex-col items-center gap-2 py-3" aria-label="Điều hướng chính">
          {NAV.filter(n => !n.hidden).map(({ path, label, icon: Icon }) => (
            <NavLink key={path} to={path} end={path === '/'} aria-label={label}
              className={({ isActive }) => `${ITEM} ${isActive
                ? 'bg-primary-soft text-primary before:absolute before:-left-2.5 before:h-6 before:w-1 before:rounded-r before:bg-primary'
                : 'text-muted hover:bg-hover hover:text-navy'}`}>
              <Icon size={20} aria-hidden="true" />
              <span className={TIP} aria-hidden="true">{label}</span>
            </NavLink>
          ))}
        </nav>
        <div className="flex w-full justify-center border-t border-line py-3">
          <button type="button" onClick={() => { logout(); navigate('/login', { replace: true }) }} aria-label="Đăng xuất"
            className={`${ITEM} text-muted hover:bg-hover hover:text-danger`}>
            <LogOut size={20} aria-hidden="true" />
            <span className={TIP} aria-hidden="true">Đăng xuất</span>
          </button>
        </div>
      </aside>

      <div className="min-w-0 flex-1">
        <header className="sticky top-0 z-10 flex h-14 items-center gap-3 border-b border-line bg-white px-4">
          {caseName ? (
            <h1 className="flex min-w-0 flex-1 items-center gap-1 text-lg font-semibold text-navy">
              <Link to="/cases" className="shrink-0 text-muted transition-colors hover:text-primary">{title}</Link>
              <ChevronRight className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
              <span className="truncate" title={caseName}>{caseName}</span>
            </h1>
          ) : <h1 className="flex-1 truncate text-lg font-semibold text-navy">{title}</h1>}
          <span className="flex items-center gap-1.5 text-sm text-muted">
            <span className={`h-2 w-2 rounded-full ${conn.bad ? 'bg-danger' : conn.n ? 'bg-success' : 'bg-muted'}`} aria-hidden="true" />
            {conn.n > 0 ? `${conn.n} thiết bị` : 'Không thiết bị'}{conn.bad > 0 && <span className="font-medium text-danger"> · {conn.bad} lỗi</span>}
          </span>
          <span className="flex items-center gap-2 text-sm text-ink">
            <span className="flex h-8 w-8 items-center justify-center rounded-full bg-primary-soft text-xs font-semibold text-navy" aria-hidden="true">
              {user.slice(0, 1).toUpperCase()}
            </span>
            <span className="hidden sm:inline">ĐTV {user}</span>
          </span>
        </header>
        <main className="min-h-[calc(100vh-56px)] bg-canvas p-4">
          <Suspense fallback={<div className="h-24 animate-pulse rounded-xl bg-white" aria-label="Đang tải" />}>
            {/* key=pathname: remount mỗi khi đổi route để chạy animation fade+slide */}
            <div key={pathname} className="page-enter">
              <Outlet />
            </div>
          </Suspense>
        </main>
      </div>
    </div>
  )
}
