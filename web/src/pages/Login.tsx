import { useState, useEffect } from 'react'
import type { FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { BarChart3, Eye, EyeOff, Fingerprint, Globe, HelpCircle, Lock, LogIn, Monitor, Moon, ShieldCheck, Sun, User, X, Zap } from 'lucide-react'
import { login } from '../auth'
import { api, ApiError } from '../api'
import { useI18n } from '../i18n'
import type { Theme } from '../i18n'

const REMEMBER_KEY = 'mf_remember_user'

export default function Login() {
  const navigate = useNavigate()
  const { lang, setLang, theme, setTheme } = useI18n()
  const isVi = lang === 'vi'
  const isDark = theme === 'dark'
  const isLightHud = theme === 'light'
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
    if (!name.trim()) next.name = isVi ? 'Vui lòng nhập tên đăng nhập' : 'Please enter your username'
    if (!pass) next.pass = isVi ? 'Vui lòng nhập mật khẩu' : 'Please enter your password'
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
        general: x instanceof ApiError
          ? x.message
          : (isVi ? 'Không thể kết nối đến máy chủ xác thực' : 'Cannot connect to authentication server'),
      })
    } finally {
      setBusy(false)
    }
  }

  const rootBg = isDark
    ? { background: "#050f24 url('/bg-login.jpg') center / cover no-repeat" }
    : isLightHud
    ? { background: "#eef5fc url('/bg-login-light.jpg') center / cover no-repeat" }
    : undefined

  return (
    <div
      className={`relative flex min-h-screen flex-col lg:flex-row font-sans overflow-hidden selection:bg-[#00b8ff]/30 ${
        isDark ? 'text-[#e6f1ff] selection:text-white' : 'bg-[#f4f7fb] text-slate-800 selection:text-[#0077cc]'
      }`}
      style={rootBg}
    >
      {/* Bộ chọn Giao diện (Tối/Sáng/Thường) & Ngôn ngữ góc trên phải */}
      <div className={`fixed top-4 right-5 z-50 flex flex-wrap items-center gap-4 text-[13px] ${isDark ? 'text-slate-200' : 'text-slate-700'}`}>
        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            {isDark ? <Moon size={15} className="text-[#38c8ff]" /> : isLightHud ? <Sun size={15} className="text-[#0077cc]" /> : <Monitor size={15} className="text-[#0077cc]" />}
            <span>{isVi ? 'Giao diện' : 'Theme'}</span>
          </span>
          <select
            value={theme}
            onChange={(e) => setTheme(e.target.value as Theme)}
            aria-label={isVi ? 'Giao diện' : 'Theme'}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-all cursor-pointer focus:outline-none ${
              isDark
                ? 'border-cyan-400/40 bg-[#081c3a]/80 backdrop-blur-md text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_14px_rgba(0,184,255,0.22)] focus:border-cyan-300 hover:border-cyan-300/80 [&>option]:bg-[#081c3a] [&>option]:text-white'
                : 'border-sky-300/70 bg-white/85 backdrop-blur-md text-slate-800 shadow-sm focus:border-[#0077cc] hover:border-sky-400'
            }`}
          >
            <option value="dark">{isVi ? 'Tối' : 'Dark'}</option>
            <option value="light">{isVi ? 'Sáng' : 'Light'}</option>
            <option value="normal">{isVi ? 'Thường' : 'Normal'}</option>
          </select>
        </div>

        <div className="flex items-center gap-2">
          <span className={`inline-flex items-center gap-1.5 ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
            <Globe size={15} className={isDark ? 'text-[#38c8ff]' : 'text-[#0077cc]'} />
            <span>{isVi ? 'Ngôn ngữ' : 'Language'}</span>
          </span>
          <select
            value={lang}
            onChange={(e) => setLang(e.target.value)}
            aria-label={isVi ? 'Ngôn ngữ' : 'Language'}
            className={`rounded-lg border px-3 py-1.5 text-sm transition-all cursor-pointer focus:outline-none ${
              isDark
                ? 'border-cyan-400/40 bg-[#081c3a]/80 backdrop-blur-md text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.14),0_0_14px_rgba(0,184,255,0.22)] focus:border-cyan-300 hover:border-cyan-300/80 [&>option]:bg-[#081c3a] [&>option]:text-white'
                : 'border-sky-300/70 bg-white/85 backdrop-blur-md text-slate-800 shadow-sm focus:border-[#0077cc] hover:border-sky-400'
            }`}
          >
            <option value="en">English</option>
            <option value="vi">Tiếng Việt</option>
          </select>
        </div>
      </div>

      {/* ===================== CỘT TRÁI (50% DESKTOP) ===================== */}
      <div
        className="relative flex w-full flex-col justify-center px-8 py-14 sm:px-14 lg:w-1/2 lg:min-h-screen"
        style={!isDark && !isLightHud ? { background: 'radial-gradient(circle at 14% 16%, #123a63 0%, #0a1f44 45%, #061423 100%)' } : undefined}
      >
        <div className="relative z-10 max-w-md mx-auto lg:mx-0 lg:ml-16 xl:ml-24">
          {/* Logo DFIS */}
          <div className="mb-10 flex items-center gap-3.5">
            <div className={`flex h-11 w-11 items-center justify-center rounded-xl border ${
              isLightHud
                ? 'border-sky-400/50 bg-white/75 text-[#0077cc] shadow-[0_4px_16px_rgba(14,116,204,0.16)]'
                : 'border-cyan-400/45 bg-cyan-400/10 text-[#38e8ff] shadow-[0_0_18px_rgba(0,184,255,0.35)]'
            }`}>
              <Fingerprint className="h-7 w-7" />
            </div>
            <div className="flex flex-col leading-tight">
              <span className={`font-display text-lg font-bold tracking-wide ${isLightHud ? 'text-[#0a1f44]' : 'text-white'}`}>
                {isVi ? 'HTGĐ' : 'DFIS'}
              </span>
              <span className={`text-xs ${isLightHud ? 'text-slate-600' : 'text-slate-300/90'}`}>
                {isVi ? 'Hệ thống Giám định & Điều tra Dữ liệu số' : 'Digital Forensics Investigation System'}
              </span>
            </div>
          </div>

          {/* Tiêu đề ứng dụng */}
          <h1 className={`font-display text-4xl lg:text-[48px] font-bold tracking-tight leading-[1.12] ${isLightHud ? 'text-[#0a1f44]' : 'text-white'}`}>
            <span className="block">{isVi ? 'Giám định' : 'Forensic'}</span>
            <span className={`block ${isLightHud ? 'text-[#0077cc]' : 'text-[#38e8ff] drop-shadow-[0_0_18px_rgba(56,232,255,0.45)]'}`}>
              {isVi ? 'Điều tra số' : 'Investigation'}
            </span>
          </h1>

          {/* Subtitle */}
          <p className={`mt-4 text-base lg:text-[17px] font-normal tracking-wide ${isLightHud ? 'text-slate-600' : 'text-slate-200/90'}`}>
            {isVi ? 'Kết nối · Phân tích · Bảo mật' : 'Connect · Analyze · Secure'}
          </p>

          {/* Thanh gạch ngang phát sáng */}
          <div className={`mt-5 mb-8 h-1 w-14 rounded-full ${isLightHud ? 'bg-[#0077cc] shadow-[0_0_10px_rgba(0,119,204,0.45)]' : 'bg-[#38e8ff] shadow-[0_0_14px_rgba(56,232,255,0.85)]'}`} />

          {/* 3 tính năng nổi bật */}
          <div className={`flex flex-col gap-4 text-[15px] lg:text-[16px] font-medium ${isLightHud ? 'text-[#0f2544]' : 'text-white/95'}`}>
            {[
              [ShieldCheck, isVi ? 'An toàn dữ liệu' : 'Data Security'],
              [Zap, isVi ? 'Xác thực nhanh chóng' : 'Fast Authentication'],
              [BarChart3, isVi ? 'Hỗ trợ điều tra hiệu quả' : 'Effective Investigation Support'],
            ].map(([Icon, label], idx) => {
              const Ic = Icon as typeof ShieldCheck
              return (
                <div key={idx} className="flex items-center gap-3.5">
                  <div className={`flex h-8 w-8 items-center justify-center rounded-lg border ${
                    isLightHud
                      ? 'border-sky-400/45 bg-white/80 text-[#0077cc] shadow-[0_2px_10px_rgba(14,116,204,0.14)]'
                      : 'border-cyan-400/40 bg-cyan-400/10 text-[#38e8ff] shadow-[inset_0_1px_0_rgba(255,255,255,0.16),0_0_12px_rgba(0,184,255,0.25)]'
                  }`}>
                    <Ic className="h-4.5 w-4.5 stroke-[2.2]" />
                  </div>
                  <span>{label as string}</span>
                </div>
              )
            })}
          </div>
        </div>
      </div>

      {/* ===================== FORM PHẢI (50% DESKTOP) ===================== */}
      <div className="relative flex flex-1 items-center justify-center p-6 sm:p-10 lg:p-12">
        <div
          className={`relative z-10 w-full max-w-[430px] rounded-[26px] border p-8 sm:p-10 transition-colors ${
            isDark
              ? 'border-cyan-400/45 bg-[#061836]/72 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(186,245,255,0.4),inset_0_0_32px_rgba(0,184,255,0.1),0_0_42px_rgba(0,170,255,0.28)]'
              : isLightHud
              ? 'border-sky-300/65 bg-white/75 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(255,255,255,0.95),0_18px_44px_rgba(14,116,204,0.16)]'
              : 'border-slate-200 bg-white shadow-[0_24px_60px_-12px_rgba(15,42,74,0.12)]'
          }`}
        >
          {/* Header Card */}
          <div className="mb-7 flex items-center justify-center gap-3.5">
            <svg
              className={`h-12 w-11 shrink-0 ${isDark ? 'drop-shadow-[0_0_14px_rgba(0,210,255,0.65)]' : ''}`}
              viewBox="0 0 24 28"
              fill="none"
              xmlns="http://www.w3.org/2000/svg"
            >
              <path
                d="M12 1.5L2.5 5.5V13C2.5 19.8 6.8 24.8 12 26.5C17.2 24.8 21.5 19.8 21.5 13V5.5L12 1.5Z"
                fill={isDark ? 'rgba(6, 28, 62, 0.85)' : '#0a1f44'}
                stroke={isDark ? '#38e8ff' : '#0a1f44'}
                strokeWidth="1.6"
              />
              <path d="M7.5 13.5C7.5 10.8 9.5 8.8 12 8.8C14.5 8.8 16.5 10.8 16.5 13.5V15.5" stroke={isDark ? '#38e8ff' : '#00b8ff'} strokeWidth="1.6" strokeLinecap="round" />
              <path d="M9.8 14.5C9.8 13.2 10.8 12.2 12 12.2C13.2 12.2 14.2 13.2 14.2 14.5V17" stroke={isDark ? '#38e8ff' : '#00b8ff'} strokeWidth="1.6" strokeLinecap="round" />
              <path d="M12 15.2V19.2" stroke={isDark ? '#38e8ff' : '#00b8ff'} strokeWidth="1.6" strokeLinecap="round" />
            </svg>

            <div className="flex flex-col">
              <span className={`font-display text-[19px] font-extrabold tracking-wider leading-none ${isDark ? 'text-white' : 'text-[#0a1f44]'}`}>
                {isVi ? 'GIÁM ĐỊNH' : 'FORENSIC'}
              </span>
              <span className={`font-display text-[19px] font-extrabold tracking-wider leading-none mt-1 ${isDark ? 'text-[#38e8ff]' : 'text-[#0077cc]'}`}>
                {isVi ? 'ĐIỀU TRA SỐ' : 'INVESTIGATION'}
              </span>
              <span className={`mt-1 text-[11px] ${isDark ? 'text-slate-300/85' : 'text-slate-500'}`}>
                {isVi ? 'Hệ thống Giám định & Điều tra Dữ liệu số' : 'Digital Forensics Investigation System'}
              </span>
            </div>
          </div>

          {/* Form */}
          <form onSubmit={submit} noValidate className="flex flex-col gap-4">
            {/* Tên đăng nhập */}
            <div>
              <div className="relative flex items-center">
                <User size={18} className="pointer-events-none absolute left-4 text-slate-400" />
                <input
                  id="name"
                  type="text"
                  value={name}
                  onChange={(e) => {
                    setName(e.target.value)
                    if (err.name || err.general) setErr({})
                  }}
                  placeholder={isVi ? 'Tên đăng nhập' : 'Username'}
                  autoComplete="username"
                  className={`h-[48px] w-full rounded-xl border pl-11 pr-4 text-[15px] placeholder:text-slate-400 transition-all outline-none ${
                    isDark
                      ? `bg-[#061630]/80 text-white ${err.name ? 'border-rose-400/80 focus:border-rose-400' : 'border-cyan-400/35 focus:border-cyan-300 focus:shadow-[0_0_16px_rgba(0,200,255,0.42)] hover:border-cyan-400/60'}`
                      : `bg-white/90 text-slate-800 ${err.name ? 'border-red-400 focus:border-red-500' : 'border-slate-200 focus:border-[#0077cc] focus:ring-2 focus:ring-[#0077cc]/15'}`
                  }`}
                />
              </div>
              {err.name && <p className="mt-1.5 pl-1 text-[13px] text-rose-500">{err.name}</p>}
            </div>

            {/* Mật khẩu */}
            <div>
              <div className="relative flex items-center">
                <Lock size={18} className="pointer-events-none absolute left-4 text-slate-400" />
                <input
                  id="pass"
                  type={show ? 'text' : 'password'}
                  value={pass}
                  onChange={(e) => {
                    setPass(e.target.value)
                    if (err.pass || err.general) setErr({})
                  }}
                  placeholder={isVi ? 'Mật khẩu' : 'Password'}
                  autoComplete="current-password"
                  className={`h-[48px] w-full rounded-xl border pl-11 pr-11 text-[15px] placeholder:text-slate-400 transition-all outline-none ${
                    isDark
                      ? `bg-[#061630]/80 text-white ${err.pass ? 'border-rose-400/80 focus:border-rose-400' : 'border-cyan-400/35 focus:border-cyan-300 focus:shadow-[0_0_16px_rgba(0,200,255,0.42)] hover:border-cyan-400/60'}`
                      : `bg-white/90 text-slate-800 ${err.pass ? 'border-red-400 focus:border-red-500' : 'border-slate-200 focus:border-[#0077cc] focus:ring-2 focus:ring-[#0077cc]/15'}`
                  }`}
                />
                <button
                  type="button"
                  onClick={() => setShow(!show)}
                  aria-label={show ? (isVi ? 'Ẩn mật khẩu' : 'Hide password') : (isVi ? 'Hiện mật khẩu' : 'Show password')}
                  className={`absolute right-3.5 p-1 transition-colors cursor-pointer ${isDark ? 'text-slate-400 hover:text-cyan-300' : 'text-slate-400 hover:text-slate-600'}`}
                >
                  {show ? <Eye size={19} /> : <EyeOff size={19} />}
                </button>
              </div>
              {err.pass && <p className="mt-1.5 pl-1 text-[13px] text-rose-500">{err.pass}</p>}
            </div>

            {/* Lỗi chung */}
            {err.general && (
              <div className={`rounded-lg px-3.5 py-2.5 text-xs sm:text-sm border ${
                isDark ? 'bg-rose-500/15 text-rose-300 border-rose-400/40' : 'bg-red-50 text-red-600 border-red-200'
              }`}>
                {err.general}
              </div>
            )}

            {/* Ghi nhớ đăng nhập */}
            <div className="pt-0.5">
              <label className={`inline-flex items-center gap-2.5 text-[14px] cursor-pointer select-none ${isDark ? 'text-slate-200' : 'text-slate-600'}`}>
                <input
                  type="checkbox"
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                  className="h-4 w-4 rounded border-cyan-400/50 accent-[#00b8ff] cursor-pointer"
                />
                <span>{isVi ? 'Ghi nhớ đăng nhập' : 'Remember me'}</span>
              </label>
            </div>

            {/* Nút Đăng nhập */}
            <button
              type="submit"
              disabled={busy}
              className={`mt-1 flex h-[48px] w-full items-center justify-center gap-2.5 rounded-xl text-[15px] font-semibold transition-all active:translate-y-0 active:scale-[0.99] cursor-pointer disabled:opacity-70 disabled:cursor-not-allowed ${
                isDark
                  ? 'border border-cyan-300/75 bg-gradient-to-r from-[#00dcff] via-[#0099ee] to-[#0066cc] text-[#04142c] shadow-[inset_0_1px_0_rgba(255,255,255,0.45),0_0_22px_rgba(0,200,255,0.55)] hover:-translate-y-0.5 hover:brightness-110 hover:shadow-[inset_0_1px_0_rgba(255,255,255,0.55),0_0_32px_rgba(0,220,255,0.8)]'
                  : isLightHud
                  ? 'border border-sky-400/60 bg-gradient-to-r from-[#00b8ff] to-[#0077cc] text-white shadow-[0_6px_20px_rgba(0,140,230,0.32)] hover:-translate-y-0.5 hover:brightness-105'
                  : 'bg-[#0077cc] text-white shadow-md shadow-[#0077cc]/25 hover:bg-[#0063ad]'
              }`}
            >
              <LogIn size={19} />
              <span>{busy ? (isVi ? 'Đang xác thực...' : 'Signing in...') : (isVi ? 'Đăng nhập' : 'Sign in')}</span>
            </button>

            {/* Phân cách Hoặc */}
            <div className="my-2.5 flex items-center gap-3">
              <div className={`h-px flex-1 ${isDark ? 'bg-cyan-400/25' : 'bg-slate-200'}`} />
              <span className="text-xs text-slate-400 font-normal">{isVi ? 'Hoặc' : 'Or'}</span>
              <div className={`h-px flex-1 ${isDark ? 'bg-cyan-400/25' : 'bg-slate-200'}`} />
            </div>

            {/* Nút Trợ giúp */}
            <button
              type="button"
              onClick={() => setShowHelp(true)}
              className={`mx-auto flex items-center justify-center gap-2 text-[14px] transition-colors cursor-pointer py-1 ${
                isDark ? 'text-slate-300 hover:text-[#38e8ff]' : 'text-slate-500 hover:text-slate-800'
              }`}
            >
              <HelpCircle size={17} className="text-slate-400" />
              <span>{isVi ? 'Trợ giúp' : 'Help'}</span>
            </button>
          </form>
        </div>
      </div>

      {/* Modal Trợ giúp */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 backdrop-blur-xs p-4">
          <div className={`w-full max-w-sm rounded-2xl border p-6 ${
            isDark
              ? 'border-cyan-400/45 bg-[#06142e]/95 backdrop-blur-xl shadow-[inset_0_1px_0_rgba(165,243,252,0.25),0_0_32px_rgba(0,184,255,0.38)]'
              : 'border-slate-200 bg-white shadow-xl'
          }`}>
            <div className="flex items-start justify-between">
              <div className={`flex items-center gap-2 font-semibold text-base ${isDark ? 'text-[#38e8ff]' : 'text-[#0077cc]'}`}>
                <HelpCircle size={20} />
                <span>{isVi ? 'Hỗ trợ đăng nhập' : 'Sign-in Support'}</span>
              </div>
              <button
                type="button"
                onClick={() => setShowHelp(false)}
                className="text-slate-400 hover:text-slate-600 transition-colors p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>
            <div className={`mt-3 text-sm space-y-2 leading-relaxed ${isDark ? 'text-slate-300' : 'text-slate-600'}`}>
              <p>
                {isVi ? (
                  <>Hệ thống <strong className={isDark ? 'text-white' : 'text-slate-900'}>Forensic Investigation</strong> dành riêng cho các điều tra viên và cán bộ được cấp quyền.</>
                ) : (
                  <>The <strong className={isDark ? 'text-white' : 'text-slate-900'}>Forensic Investigation</strong> system is restricted to authorized investigators and personnel.</>
                )}
              </p>
              <p>
                {isVi
                  ? 'Nếu bạn quên mật khẩu hoặc cần tạo tài khoản mới, vui lòng liên hệ quản trị viên hệ thống để được hỗ trợ.'
                  : 'If you forgot your password or need a new account, please contact your system administrator for assistance.'}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setShowHelp(false)}
              className="mt-5 w-full rounded-xl border border-cyan-300/70 bg-gradient-to-r from-[#00d2ff] to-[#0077cc] py-2.5 text-sm font-semibold text-white shadow-[0_0_18px_rgba(0,184,255,0.45)] hover:brightness-110 transition-all cursor-pointer"
            >
              {isVi ? 'Đã hiểu' : 'Got it'}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}