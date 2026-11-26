import { useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Eye, EyeOff, HelpCircle, Lock, LogIn, ShieldCheck, User, X, Zap } from 'lucide-react'
import { login } from '../auth'
import { api, ApiError } from '../api'
import { useI18n } from '../i18n'

const REMEMBER_KEY = 'mf_remember_user'

export default function Login() {
  const navigate = useNavigate()
  const { lang, setLang } = useI18n()
  const [name, setName] = useState('')
  const [pass, setPass] = useState('')
  const [show, setShow] = useState(false)
  const [remember, setRemember] = useState(false)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<{ name?: string; pass?: string; general?: string }>({})
  const [showHelp, setShowHelp] = useState(false)

  useEffect(() => {
    const saved = localStorage.getItem(REMEMBER_KEY)
    if (saved) {
      setName(saved)
      setRemember(true)
    }
  }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const next: typeof err = {}
    if (!name.trim()) next.name = 'Vui lòng nhập tên đăng nhập'
    if (!pass) next.pass = 'Vui lòng nhập mật khẩu'
    setErr(next)
    if (next.name || next.pass) return

    setBusy(true)
    try {
      const res = await api.login(name.trim(), pass)
      if (remember) {
        localStorage.setItem(REMEMBER_KEY, name.trim())
      } else {
        localStorage.removeItem(REMEMBER_KEY)
      }
      login(res.username)
      navigate('/')
    } catch (x) {
      setErr({
        general: x instanceof ApiError ? x.message : 'Không thể kết nối đến máy chủ xác thực',
      })
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex min-h-screen flex-col lg:flex-row bg-[#f6f9fb] text-slate-800 font-sans selection:bg-[#4a7dff]/20 selection:text-[#008f86]">
      <div className="fixed top-3 right-3 z-50 rounded-md bg-white/90 border border-slate-200 px-2.5 py-1.5 shadow-sm">
            <label className="flex items-center gap-2 text-[13px] text-slate-600">
              <span>{lang === 'vi' ? 'Ngôn ngữ' : 'Language'}</span>
              <select
                value={lang}
                onChange={(e) => setLang(e.target.value)}
                className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 text-sm text-slate-800 focus:outline-none focus:border-[#0077cc] cursor-pointer"
              >
                <option value="en">English</option>
                <option value="vi">Tiếng Việt</option>
              </select>
            </label>
      </div>
      {/* ===================== BANNER TRÁI (50% DESKTOP) ===================== */}
      <div
        className="relative flex w-full flex-col justify-center overflow-hidden px-8 py-14 sm:px-14 lg:w-1/2 lg:min-h-screen"
        style={{
          background:
            'radial-gradient(circle at 14% 16%, #123a63 0%, #0a1f44 30%, #0c233e 55%, #091a30 80%, #061423 100%)',
        }}
      >
        {/* Dải sóng cyber luminous mượt mà (Wave ribbons) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 1000 1000"
            fill="none"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="wave-cyan-grad" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#00f2e5" stopOpacity="0.85" />
                <stop offset="35%" stopColor="#00b4d8" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#005f73" stopOpacity="0.05" />
              </linearGradient>
              <linearGradient id="wave-cyan-soft" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#00f5d4" stopOpacity="0.7" />
                <stop offset="50%" stopColor="#009688" stopOpacity="0.35" />
                <stop offset="100%" stopColor="#023e8a" stopOpacity="0" />
              </linearGradient>
              <filter id="wave-glow" x="-20%" y="-20%" width="140%" height="140%">
                <feGaussianBlur stdDeviation="5" result="blur" />
                <feComposite in="SourceGraphic" in2="blur" operator="over" />
              </filter>
            </defs>

            {/* Chùm dải sóng 1: Uốn lượn chéo từ góc dưới trái lên góc trên phải */}
            {Array.from({ length: 14 }).map((_, i) => (
              <path
                key={`up-${i}`}
                d={`M-80,${580 - i * 16} C180,${430 - i * 12} 460,${480 - i * 15} 740,${220 - i * 14} C880,${100 - i * 8} 940,${60 - i * 6} 1100,${-20 - i * 4}`}
                stroke="url(#wave-cyan-grad)"
                strokeWidth={i === 0 ? '1.8' : '1.1'}
                strokeOpacity={Math.max(0.08, 0.72 - i * 0.048)}
                filter={i === 0 ? 'url(#wave-glow)' : undefined}
                fill="none"
              />
            ))}

            {/* Chùm dải sóng 2: Uốn lượn ở tầng dưới xuyên suốt từ trái qua phải */}
            {Array.from({ length: 14 }).map((_, i) => (
              <path
                key={`down-${i}`}
                d={`M-80,${780 - i * 14} C160,${710 - i * 11} 410,${810 - i * 13} 690,${650 - i * 10} C840,${560 - i * 8} 970,${590 - i * 6} 1100,${520 - i * 6}`}
                stroke="url(#wave-cyan-soft)"
                strokeWidth={i === 0 ? '1.6' : '1.1'}
                strokeOpacity={Math.max(0.06, 0.65 - i * 0.046)}
                filter={i === 0 ? 'url(#wave-glow)' : undefined}
                fill="none"
              />
            ))}
          </svg>
        </div>

        {/* Khối nội dung bên trái */}
        <div className="relative z-10 max-w-md mx-auto lg:mx-0 lg:ml-24 xl:ml-36">
          {/* Logo Khiên + Vân tay phát sáng */}
          <div className="mb-5 inline-flex items-center justify-center">
            <svg
              className="h-[72px] w-[62px] text-[#4a7dff] drop-shadow-[0_0_16px_rgba(0,210,196,0.6)]"
              viewBox="0 0 48 56"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M24 3.5L7 9.5V24C7 36 14.8 46.5 24 50.5C33.2 46.5 41 36 41 24V9.5L24 3.5Z"
                stroke="currentColor"
                strokeWidth="3.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                fill="rgba(0, 36, 46, 0.45)"
              />
              <path
                d="M17 26C17 21.8 20.1 18.2 24 18.2C27.9 18.2 31 21.8 31 26V29"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              <path
                d="M20.5 27.5C20.5 25.2 22 23.2 24 23.2C26 23.2 27.5 25.2 27.5 27.5V32"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
              <path
                d="M24 28.5V35.5"
                stroke="currentColor"
                strokeWidth="2.5"
                strokeLinecap="round"
              />
            </svg>
          </div>

          {/* Tiêu đề ứng dụng */}
          <h1 className="font-display text-4xl lg:text-[46px] font-bold tracking-tight text-white leading-tight">
            <span>Forensic </span>
            <span className="text-[#4a7dff]">Investigation</span>
          </h1>

          {/* Subtitle */}
          <p className="mt-3 text-base lg:text-[17px] font-normal tracking-wide text-[#98ded9]">
            Kết nối &bull; Phân tích &bull; Bảo mật
          </p>

          {/* Thanh gạch ngang bo tròn trang trí */}
          <div className="mt-5 mb-8 h-1 w-12 rounded-full bg-[#4a7dff]" />

          {/* 3 tính năng nổi bật */}
          <div className="flex flex-col gap-4 text-[15px] lg:text-[16px] font-medium text-white/95">
            <div className="flex items-center gap-3.5">
              <div className="flex h-6 w-6 items-center justify-center text-[#4a7dff]">
                <ShieldCheck className="h-5 w-5 stroke-[2.2]" />
              </div>
              <span>An toàn dữ liệu</span>
            </div>

            <div className="flex items-center gap-3.5">
              <div className="flex h-6 w-6 items-center justify-center text-[#4a7dff]">
                <Zap className="h-5 w-5 stroke-[2.2]" />
              </div>
              <span>Xác thực nhanh chóng</span>
            </div>

            <div className="flex items-center gap-3.5">
              <div className="flex h-6 w-6 items-center justify-center text-[#4a7dff]">
                <svg
                  className="h-5 w-5"
                  viewBox="0 0 24 24"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="2.2"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                >
                  <path d="M3 20h18" />
                  <path d="M6 20v-5" />
                  <path d="M11 20v-9" />
                  <path d="M16 20V7" />
                  <path d="M5 14l5-5 5-3 5 3" />
                </svg>
              </div>
              <span>Hỗ trợ điều tra hiệu quả</span>
            </div>
          </div>
        </div>
      </div>

      {/* ===================== FORM PHẢI (50% DESKTOP) ===================== */}
      <div className="relative flex flex-1 items-center justify-center overflow-hidden p-6 sm:p-10 lg:p-12">
        {/* Nền gợn sóng sáng thanh lịch phía sau (Subtle light waves) */}
        <div className="pointer-events-none absolute inset-0 overflow-hidden">
          <svg
            className="absolute inset-0 h-full w-full"
            viewBox="0 0 1000 1000"
            fill="none"
            preserveAspectRatio="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <defs>
              <linearGradient id="soft-wave-1" x1="0%" y1="0%" x2="100%" y2="100%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.9" />
                <stop offset="45%" stopColor="#eaf1f5" stopOpacity="0.6" />
                <stop offset="100%" stopColor="#dce8ee" stopOpacity="0.35" />
              </linearGradient>
              <linearGradient id="soft-wave-2" x1="100%" y1="0%" x2="0%" y2="100%">
                <stop offset="0%" stopColor="#ffffff" stopOpacity="0.8" />
                <stop offset="55%" stopColor="#edf4f8" stopOpacity="0.5" />
                <stop offset="100%" stopColor="#e2ebf1" stopOpacity="0.25" />
              </linearGradient>
            </defs>
            <path
              d="M0,140 C350,50 650,380 1000,180 L1000,1000 L0,1000 Z"
              fill="url(#soft-wave-1)"
            />
            <path
              d="M0,420 C400,280 600,680 1000,450 L1000,1000 L0,1000 Z"
              fill="url(#soft-wave-2)"
            />
          </svg>
        </div>

        {/* Khung đăng nhập (Card) — Đã tăng kích thước rộng hơn, thoáng đãng và dễ nhìn hơn */}
        <div className="relative z-10 w-full max-w-[440px] sm:max-w-[460px] rounded-[28px] border border-slate-100/90 bg-white p-9 sm:p-11 shadow-[0_24px_60px_-12px_rgba(15,42,74,0.09),0_2px_8px_rgba(0,0,0,0.02)]">
          {/* Header Card: Logo icon + Chữ FORENSIC INVESTIGATION */}
          <div className="mb-8 flex items-center justify-center gap-3.5">
            {/* Khiên navy + vân tay cyan */}
            <svg
              className="h-12 w-11 shrink-0"
              viewBox="0 0 24 28"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 1.5L2.5 5.5V13C2.5 19.8 6.8 24.8 12 26.5C17.2 24.8 21.5 19.8 21.5 13V5.5L12 1.5Z"
                fill="#0a1f44"
              />
              <path
                d="M7.5 13.5C7.5 10.8 9.5 8.8 12 8.8C14.5 8.8 16.5 10.8 16.5 13.5V15.5"
                stroke="#0077cc"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M9.8 14.5C9.8 13.2 10.8 12.2 12 12.2C13.2 12.2 14.2 13.2 14.2 14.5V17"
                stroke="#0077cc"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
              <path
                d="M12 15.2V19.2"
                stroke="#0077cc"
                strokeWidth="1.6"
                strokeLinecap="round"
              />
            </svg>

            {/* Chữ thương hiệu 2 tầng lớn hơn */}
            <div className="flex flex-col">
              <span className="font-display text-[19px] sm:text-[20px] font-extrabold tracking-wider text-[#0a1f44] leading-none">
                FORENSIC
              </span>
              <span className="font-display text-[19px] sm:text-[20px] font-extrabold tracking-wider text-[#4a7dff] leading-none mt-1">
                INVESTIGATION
              </span>
            </div>
          </div>


          {/* Form */}
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            {/* Trường Tên đăng nhập */}
            <div>
              <div className="relative flex items-center">
                <User
                  size={20}
                  className="pointer-events-none absolute left-4 text-slate-400"
                />
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (err.name || err.general) setErr({})
                  }}
                  placeholder="Tên đăng nhập"
                  autoComplete="username"
                  className={`h-[50px] w-full rounded-xl border bg-white pl-12 pr-4 text-[15px] text-slate-800 placeholder:text-slate-400 transition-all outline-none ${
                    err.name
                      ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
                      : 'border-slate-200/90 focus:border-[#0077cc] focus:ring-2 focus:ring-[#0077cc]/15'
                  }`}
                />
              </div>
              {err.name && (
                <p className="mt-1.5 pl-1 text-[13px] text-red-500">{err.name}</p>
              )}
            </div>

            {/* Trường Mật khẩu */}
            <div>
              <div className="relative flex items-center">
                <Lock
                  size={20}
                  className="pointer-events-none absolute left-4 text-slate-400"
                />
                <input
                  id="pass"
                  type={show ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value)
                    if (err.pass || err.general) setErr({})
                  }}
                  placeholder="Mật khẩu"
                  autoComplete="current-password"
                  className={`h-[50px] w-full rounded-xl border bg-white pl-12 pr-12 text-[15px] text-slate-800 placeholder:text-slate-400 transition-all outline-none ${
                    err.pass
                      ? 'border-red-400 focus:border-red-500 focus:ring-2 focus:ring-red-100'
                      : 'border-slate-200/90 focus:border-[#0077cc] focus:ring-2 focus:ring-[#0077cc]/15'
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
                  className="absolute right-3.5 p-1 text-slate-400 hover:text-slate-600 transition-colors cursor-pointer"
                >
                  {show ? <Eye size={20} /> : <EyeOff size={20} />}
                </button>
              </div>
              {err.pass && (
                <p className="mt-1.5 pl-1 text-[13px] text-red-500">{err.pass}</p>
              )}
            </div>

            {/* Lỗi chung từ máy chủ */}
            {err.general && (
              <div className="rounded-lg bg-red-50 px-3.5 py-2.5 text-xs sm:text-sm text-red-600 border border-red-200/70">
                {err.general}
              </div>
            )}

            {/* Checkbox Ghi nhớ đăng nhập */}
            <div className="pt-0.5">
              <label className="inline-flex items-center gap-2.5 text-[14px] text-slate-600 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4.5 w-4.5 rounded border-slate-300 text-[#0077cc] focus:ring-[#0077cc] accent-[#0077cc] cursor-pointer"
                />
                <span>Ghi nhớ đăng nhập</span>
              </label>
            </div>

            {/* Nút Đăng nhập */}
            <button
              type="submit"
              disabled={busy}
              className="mt-1 flex h-[50px] w-full items-center justify-center gap-2.5 rounded-xl bg-[#0077cc] text-[16px] font-medium text-white shadow-md shadow-[#0077cc]/20 transition-all hover:bg-[#0063ad] active:scale-[0.99] cursor-pointer disabled:opacity-75 disabled:cursor-not-allowed"
            >
              <LogIn size={20} />
              <span>{busy ? 'Đang xác thực...' : 'Đăng nhập'}</span>
            </button>

            {/* Phân cách Hoặc */}
            <div className="relative my-3.5 flex items-center justify-center">
              <div className="w-full border-t border-slate-200/80" />
              <span className="absolute bg-white px-3.5 text-xs sm:text-sm text-slate-400 font-normal">
                Hoặc
              </span>
            </div>

            {/* Nút Trợ giúp */}
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className="mx-auto flex items-center justify-center gap-2 text-[14px] text-slate-500 hover:text-slate-800 transition-colors cursor-pointer py-1"
            >
              <HelpCircle size={17} className="text-slate-400" />
              <span>Trợ giúp</span>
            </button>
          </form>
        </div>
      </div>

      {/* Modal Trợ giúp */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/40 backdrop-blur-xs p-4 animate-in fade-in duration-200">
          <div className="w-full max-w-sm rounded-2xl bg-white p-6 shadow-xl border border-slate-100">
            <div className="flex items-start justify-between">
              <div className="flex items-center gap-2 text-[#0077cc] font-semibold text-base">
                <HelpCircle size={20} />
                <span>Hỗ trợ đăng nhập</span>
              </div>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <div className="mt-3 text-sm text-slate-600 space-y-2 leading-relaxed">
              <p>
                Hệ thống <strong>Forensic Investigation</strong> dành riêng cho các điều tra viên và cán bộ được cấp quyền.
              </p>
              <p>
                Nếu bạn quên mật khẩu hoặc cần tạo tài khoản mới, vui lòng liên hệ quản trị viên hệ thống để được hỗ trợ.
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="mt-5 w-full rounded-xl bg-[#0077cc] py-2.5 text-sm font-medium text-white hover:bg-[#0063ad] transition-colors cursor-pointer"
            >
              Đã hiểu
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
