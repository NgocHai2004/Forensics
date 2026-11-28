import { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Bell, CheckCircle2, Trash2, Check } from 'lucide-react'
import { useI18n } from './i18n'

export interface NotifItem {
  id: number
  msg: string
  time: string
  read: boolean
}

interface NotifyCtx {
  items: NotifItem[]
  unread: number
  notify: (msg: string) => void
  markAllRead: () => void
  clearAll: () => void
}

const Ctx = createContext<NotifyCtx>({
  items: [],
  unread: 0,
  notify: () => {},
  markAllRead: () => {},
  clearAll: () => {},
})

const STORAGE_KEY = 'mf_notifs'

function fmtNow() {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())} ${p(d.getDate())}/${p(d.getMonth() + 1)}`
}

export function NotificationProvider({ children }: { children: ReactNode }) {
  const [items, setItems] = useState<NotifItem[]>(() => {
    try {
      const raw = localStorage.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : []
    } catch {
      return []
    }
  })
  const [toast, setToast] = useState<string | null>(null)
  const timerRef = useRef<number | null>(null)

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(items.slice(0, 50)))
    } catch {
      // ignore storage quota
    }
  }, [items])

  const notify = useCallback((msg: string) => {
    if (!msg) return
    setItems(prev => [{ id: Date.now() + Math.random(), msg, time: fmtNow(), read: false }, ...prev].slice(0, 50))
    setToast(msg)
    if (timerRef.current) window.clearTimeout(timerRef.current)
    timerRef.current = window.setTimeout(() => setToast(null), 4000)
  }, [])

  const markAllRead = useCallback(() => {
    setItems(prev => prev.map(x => (x.read ? x : { ...x, read: true })))
  }, [])

  const clearAll = useCallback(() => {
    setItems([])
  }, [])

  const unread = items.filter(x => !x.read).length

  return (
    <Ctx.Provider value={{ items, unread, notify, markAllRead, clearAll }}>
      {children}
      {toast && (
        <div
          role="status"
          className="fixed bottom-5 right-5 z-[80] flex max-w-md items-center gap-2 rounded-xl border border-[#00b8ff]/50 bg-[#061836]/95 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_24px_rgba(0,184,255,0.45)] backdrop-blur-md"
        >
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[#38c8ff]" aria-hidden="true" />
          <span className="truncate">{toast}</span>
        </div>
      )}
    </Ctx.Provider>
  )
}

export function useNotify() {
  return useContext(Ctx)
}

export function NotificationBell() {
  const { items, unread, markAllRead, clearAll } = useNotify()
  const { lang } = useI18n()
  const isVi = lang === 'vi'
  const L = (vi: string, en: string) => (isVi ? vi : en)
  const [open, setOpen] = useState(false)
  const wrapRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (!open) return
    const onDoc = (e: globalThis.MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) setOpen(false)
    }
    document.addEventListener('mousedown', onDoc)
    return () => document.removeEventListener('mousedown', onDoc)
  }, [open])

  return (
    <div ref={wrapRef} className="relative shrink-0">
      <button
        type="button"
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next && unread > 0) markAllRead()
        }}
        title={L('Thông báo hệ thống', 'System Notifications')}
        aria-label={L('Thông báo hệ thống', 'System Notifications')}
        className="relative inline-flex items-center justify-center rounded bg-white/10 hover:bg-white/20 text-white px-2 py-1.5 text-xs transition-colors cursor-pointer"
      >
        <Bell className="h-3.5 w-3.5" aria-hidden="true" />
        {unread > 0 && (
          <span className="absolute -right-1 -top-1 flex h-4 min-w-4 items-center justify-center rounded-full bg-[#00b8ff] px-1 text-[10px] font-bold leading-none text-[#061836] shadow">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className="absolute right-0 top-full z-[90] mt-2 w-80 overflow-hidden rounded-xl border border-[#00b8ff]/35 bg-[#071a3b] text-white shadow-[0_12px_36px_rgba(0,0,0,0.55)] backdrop-blur-md">
          <div className="flex items-center justify-between border-b border-white/10 px-3.5 py-2.5">
            <span className="flex items-center gap-1.5 text-xs font-semibold text-[#38c8ff]">
              <Bell className="h-3.5 w-3.5" aria-hidden="true" />
              {L('Thông báo', 'Notifications')} ({items.length})
            </span>
            <div className="flex items-center gap-1.5">
              {items.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={markAllRead}
                    title={L('Đánh dấu đã đọc', 'Mark all read')}
                    className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-white cursor-pointer"
                  >
                    <Check className="h-3.5 w-3.5" />
                  </button>
                  <button
                    type="button"
                    onClick={clearAll}
                    title={L('Xoá tất cả', 'Clear all')}
                    className="rounded p-1 text-white/70 hover:bg-white/10 hover:text-rose-400 cursor-pointer"
                  >
                    <Trash2 className="h-3.5 w-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
          <div className="max-h-72 overflow-y-auto divide-y divide-white/10">
            {!items.length ? (
              <p className="px-4 py-6 text-center text-xs text-white/60">
                {L('Chưa có thông báo nào.', 'No notifications yet.')}
              </p>
            ) : (
              items.map(it => (
                <div key={it.id} className="flex items-start gap-2.5 px-3.5 py-2.5 text-xs hover:bg-white/5">
                  <CheckCircle2 className="mt-0.5 h-3.5 w-3.5 shrink-0 text-[#38c8ff]" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <p className="text-white/95 leading-snug break-words">{it.msg}</p>
                    <p className="mt-0.5 font-mono text-[10.5px] text-white/50">{it.time}</p>
                  </div>
                </div>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  )
}
