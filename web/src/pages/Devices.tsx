import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderPlus,
  X,
  ChevronLeft,
  ChevronRight,
  HardDrive,
  Smartphone,
  Layers,
  Files,
  AlertTriangle,
  Plus,
  LogOut,
  Download,
  Play,
  RotateCcw,
  KeyRound,
  RefreshCw
} from 'lucide-react'
import { logout } from '../auth'
import { DeviceThumb } from '../components/DeviceThumb'
import { useI18n } from '../i18n'
import { api, ApiError, fmtSize } from '../api'
import type { Case, Device, DeviceAcqState, DeviceInfo, SystemStats, SyncItem } from '../api'

type Usb = Awaited<ReturnType<typeof api.usb>>['items'][number]
type Stage = DeviceAcqState['stage']
type Card = { name: string; serial: string | null; usb?: Usb; dev?: Device }

const STAGE_CONFIG: Record<
  Stage,
  { label: string; btn: string; borderCls: string }
> = {
  // màu vạch trái của thẻ thay cho nhãn (viền ngoài để xám nhạt): vàng = đã có image, xanh dương = đang chạy, xanh lá = xong, đỏ = lỗi
  new: { label: 'Chưa đóng image', btn: 'Đóng image & Hash SHA-256', borderCls: 'border-l-line' },
  imaging: { label: 'Đang đóng image…', btn: 'Đang đóng image…', borderCls: 'border-l-blue-500' },
  imaged: { label: 'Đã có image + hash', btn: 'Bắt đầu trích xuất', borderCls: 'border-l-amber-400' },
  partial: { label: 'Trích xuất dở (bị ngắt)', btn: 'Tiếp tục trích xuất', borderCls: 'border-l-amber-400' },
  extracting: { label: 'Đang trích xuất…', btn: 'Đang trích xuất…', borderCls: 'border-l-blue-500' },
  done: { label: 'Trích xuất hoàn tất', btn: 'Xem chứng cứ vụ án', borderCls: 'border-l-emerald-500' },
  error: { label: 'Lỗi trích xuất', btn: 'Trích xuất lại', borderCls: 'border-l-rose-500' },
}

const CASE_KEY = 'mf_case'
// loại tệp cho dashboard: cùng key/màu với STORE ở CaseDetail.tsx và _STORE_SQL ở main.py
const FILE_TYPES = [
  { key: 'image', label: 'Hình ảnh', color: '#2a78d6' },
  { key: 'video', label: 'Video', color: '#eb6834' },
  { key: 'audio', label: 'Âm thanh', color: '#1baf7a' },
  { key: 'document', label: 'Tài liệu', color: '#eda100' },
  { key: 'chat', label: 'Tin nhắn', color: '#0ea5e9' },
  { key: 'archive', label: 'Tệp nén', color: '#e87ba4' },
  { key: 'apk', label: 'Tệp cài đặt', color: '#008300' },
  { key: 'appdata', label: 'Dữ liệu ứng dụng', color: '#6250d6' },
  { key: 'system', label: 'Hệ thống', color: '#e34948' },
  { key: 'other', label: 'Khác', color: '#9ca3af' },
]
const FIELD = 'h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted focus:border-primary focus:outline-none'
const BTN = 'inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50'
const BTN2 = 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-medium text-ink transition-colors duration-150 hover:bg-hover'
const DLG = 'm-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-ink shadow-xl backdrop:bg-navy/40'
const CLOSE = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-ink'

const SYNC_LABEL: Record<SyncItem['status'], string> = {
  pending: 'Chờ gửi', sending: 'Đang gửi', done: 'Đã đồng bộ', error: 'Lỗi gửi', skipped: 'Bỏ qua',
}
const SYNC_CLS: Record<SyncItem['status'], string> = {
  pending: 'bg-amber-50 text-amber-700', sending: 'bg-blue-50 text-blue-700', done: 'bg-emerald-50 text-emerald-700',
  error: 'bg-rose-50 text-rose-700', skipped: 'bg-slate-100 text-muted',
}

function formatDateTime(dStr?: string) {
  if (!dStr) return '—'
  try {
    const d = new Date(dStr)
    if (isNaN(d.getTime())) return dStr
    const pad = (n: number) => n.toString().padStart(2, '0')
    return `${pad(d.getDate())}/${pad(d.getMonth() + 1)}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`
  } catch {
    return dStr
  }
}

// Nút icon trên thẻ: nhãn hiện ngay khi di chuột / focus (title của trình duyệt hiện chậm, không hiện khi dùng bàn phím).
// Bọc span: nút bị khoá vẫn hiện lý do; chặn click lan lên thẻ (thẻ trích xuất xong bấm vào là mở chứng cứ).
function IconBtn({ label, tip, disabled, onClick, children }: {
  label: string; tip: string; disabled?: boolean; onClick: (e: MouseEvent) => void; children: ReactNode
}) {
  const id = useId()
  return (
    <span className="group/tip relative flex shrink-0" onClick={e => e.stopPropagation()}>
      <button type="button" disabled={disabled} onClick={onClick} aria-label={label} aria-describedby={tip !== label ? id : undefined}
        className="cursor-pointer rounded p-0.5 text-primary transition-colors hover:bg-primary-soft disabled:cursor-not-allowed disabled:text-muted/50 disabled:hover:bg-transparent">
        {children}
      </button>
      <span id={id} role="tooltip"
        className="invisible absolute bottom-full right-0 z-30 w-max max-w-56 rounded-md bg-navy px-2 py-1 text-[11px] font-medium leading-snug text-white opacity-0 shadow-lg transition-opacity duration-100 group-hover/tip:visible group-hover/tip:opacity-100 group-focus-within/tip:visible group-focus-within/tip:opacity-100">
        {tip}
      </span>
    </span>
  )
}

export default function Devices() {
  const navigate = useNavigate()
  const { t } = useI18n()
  const [cases, setCases] = useState<Case[] | null>(null)
  const [caseName, setCaseName] = useState('')
  const [usb, setUsb] = useState<Usb[]>([])
  const [devs, setDevs] = useState<Device[]>([])
  const [states, setStates] = useState<Record<string, DeviceAcqState>>({})
  const [err, setErr] = useState('')
  // dự kiến dữ liệu lấy được của máy đang cắm: undefined = chưa hỏi, null = đang ước tính, { error } = không đọc được (kèm lý do)
  const [est, setEst] = useState<Record<string, { bytes: number; files: number | null } | { error: string } | null>>({})
  const [newName, setNewName] = useState('')
  const [createErr, setCreateErr] = useState('')
  const [busyCreating, setBusyCreating] = useState(false)
  const [copiedKey, setCopiedKey] = useState<string | null>(null)
  const [page, setPage] = useState(0)
  useEffect(() => setPage(0), [caseName])
  // thống kê loại tệp của cả vụ án (server đếm trên toàn bộ tệp); 30 s cập nhật một lần
  const [fstat, setFstat] = useState<{ by: Record<string, { n: number; size: number }>; n: number; size: number } | null>(null)
  const [sys, setSys] = useState<SystemStats | null>(null)
  useEffect(() => {
    if (!caseName) return setFstat(null)
    let alive = true
    const load = () => {
      api.fileStats(caseName).then(s => alive && setFstat(s)).catch(() => {})
      api.cases().then(cs => alive && setCases(cs)).catch(() => {}) // số vụ án / thiết bị / tệp toàn hệ thống
      api.system().then(s => alive && setSys(s)).catch(() => {})
    }
    load()
    const id = setInterval(load, 30000)
    return () => { alive = false; clearInterval(id) }
  }, [caseName])
  const dlg = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    api.cases()
      .then((cs) => {
        setCases(cs)
        const saved = localStorage.getItem(CASE_KEY)
        setCaseName(cs.find(c => c.name === saved)?.name ?? cs[0]?.name ?? '')
      })
      .catch((e: Error) => setErr(e.message))
  }, [])

  const pickCase = (name: string) => {
    setCaseName(name)
    localStorage.setItem(CASE_KEY, name)
  }

  const openCreate = () => {
    setNewName('')
    setCreateErr('')
    dlg.current?.showModal()
    nameRef.current?.focus()
  }

  const closeOnBackdrop = (e: MouseEvent<HTMLDialogElement>) => {
    if (e.target === e.currentTarget) e.currentTarget.close()
  }

  // Đồng bộ về hệ thống trung tâm: chọn thiết bị trong vụ án -> đưa vào hàng chờ gửi image + metadata
  const syncDlg = useRef<HTMLDialogElement>(null)
  const [syncSel, setSyncSel] = useState<Set<string>>(new Set())
  const [syncs, setSyncs] = useState<Record<string, SyncItem>>({})
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const byDevice = (items: SyncItem[]) => Object.fromEntries(items.filter(s => s.status !== 'skipped').map(s => [s.device, s]))

  const openSync = () => {
    setSyncSel(new Set())
    setSyncMsg('')
    api.syncs(caseName).then(r => setSyncs(byDevice(r.items))).catch(() => setSyncs({}))
    syncDlg.current?.showModal()
  }

  const toggleSync = (name: string) => setSyncSel(s => {
    const n = new Set(s)
    if (!n.delete(name)) n.add(name)
    return n
  })

  const doSync = async () => {
    setSyncBusy(true)
    setSyncMsg('')
    try {
      const r = await api.syncQueue(caseName, [...syncSel])
      setSyncs(m => ({ ...m, ...byDevice(r.items) }))
      setSyncSel(new Set())
      const queued = r.items.filter(s => s.status !== 'skipped').length
      setSyncMsg(`Đã đưa ${queued} thiết bị vào hàng chờ đồng bộ`
        + (queued < r.items.length ? `; bỏ qua ${r.items.length - queued} máy chưa đóng image` : ''))
    } catch (e) {
      setSyncMsg((e as Error).message)
    } finally {
      setSyncBusy(false)
    }
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) { setCreateErr('Nhập tên vụ án'); return }
    setBusyCreating(true)
    setCreateErr('')
    try {
      const c = await api.createCase(newName.trim())
      setCases(cs => [c, ...(cs ?? [])])
      pickCase(c.name)
      dlg.current?.close()
    } catch (e) {
      setCreateErr(e instanceof ApiError ? e.message : 'Không gọi được máy chủ')
    } finally {
      setBusyCreating(false)
    }
  }

  const copyText = (text: string, key: string) => {
    if (!text) return
    navigator.clipboard?.writeText(text)
    setCopiedKey(key)
    setTimeout(() => setCopiedKey(k => (k === key ? null : k)), 1800)
  }

  useEffect(() => {
    let alive = true
    const tick = () =>
      Promise.all([api.usb(), api.deviceStatus(), caseName ? api.devices(caseName) : null])
        .then(([u, s, dv]) => {
          if (!alive) return
          setUsb(u.items.filter(d => d.type === 'phone' || d.type === 'hdd'))
          setStates(Object.fromEntries(s.items.map(x => [`${x.case}\n${x.device}`, x])))
          setDevs(dv ? dv.items.filter(x => x.type === 'phone' || x.type === 'hdd') : [])
        })
        .catch(() => {}) // lỗi poll (vd backend đang khởi động lại) không hiện banner; giữ dữ liệu cũ, lần poll sau tự cập nhật

    tick()
    const id = setInterval(tick, 2000)
    return () => { alive = false; clearInterval(id) }
  }, [caseName])

  // Ước tính theo serial; khi trạng thái adb của máy đổi (vd. vừa bật Gỡ lỗi USB) thì hỏi lại, không cần tải lại trang
  const adbSeen = useRef<Record<string, string | null | undefined>>({})
  useEffect(() => {
    for (const d of usb) {
      const sn = d.serial
      if (!sn) continue
      const cur = est[sn]
      const adbChanged = adbSeen.current[sn] !== d.adb
      if (sn in est && !(adbChanged && cur && 'error' in cur)) continue
      adbSeen.current[sn] = d.adb
      setEst(m => ({ ...m, [sn]: null }))
      api.deviceEstimate(sn)
        .then(r => setEst(m => ({ ...m, [sn]: r })))
        .catch((e: Error) => setEst(m => ({ ...m, [sn]: { error: e instanceof ApiError ? e.message : 'Không gọi được máy chủ' } })))
    }
  }, [usb, est])

  // Ghép nối danh sách thiết bị
  const cards: Card[] = []
  const taken = new Set<string>()

  for (const d of usb) {
    const dev = devs.find(x => !taken.has(x.name) && (x.serial ? x.serial === d.serial : x.name === d.name))
    const clash = !dev && (devs.some(x => x.name === d.name) || usb.some(o => o !== d && o.name === d.name))
    const name = dev?.name ?? (clash ? `${d.name} · ${(d.serial ?? '').slice(-4)}` : d.name)
    taken.add(name)
    cards.push({ name, serial: d.serial ?? null, usb: d, dev })
  }

  for (const x of devs) {
    if (!taken.has(x.name) && x.stage !== 'new') {
      cards.push({ name: x.name, serial: x.serial ?? null, dev: x })
    }
  }

  // 20 thẻ/trang = 4 hàng x 5 cột (dashboard biểu đồ ở trên); số trang giảm khi bớt máy thì kẹp về trang cuối
  const PAGE = 20
  const pages = Math.max(1, Math.ceil(cards.length / PAGE))
  const pg = Math.min(page, pages - 1)

  // Đóng image chỉ khi bấm nút trên thẻ; máy đã có image (đóng xong) thì tự trích xuất tiếp
  const autoTried = useRef<Record<string, string>>({})
  useEffect(() => {
    if (!caseName) return
    for (const c of cards) {
      const st = states[`${caseName}\n${c.name}`]
      const stage: Stage = (st && st.stage !== 'new' ? st.stage : c.dev?.stage) ?? 'new'
      if (st?.running || stage !== 'imaged' || autoTried.current[`x:${caseName}\n${c.name}`]) continue
      autoTried.current[`x:${caseName}\n${c.name}`] = '1'
      api.deviceExtract(caseName, c.name).catch((e: Error) => setErr(e.message))
    }
  })

  const startImage = async (c: Card, e: MouseEvent) => {
    e.stopPropagation()
    if (!caseName || !c.serial) return
    setErr('')
    try {
      await api.deviceImage(caseName, c.name, c.serial)
    } catch (err) {
      setErr((err as Error).message)
    }
  }

  // Thu thập lại iPhone: backup mã hoá lần này lấy thêm Keychain, Safari, nhật ký cuộc gọi, Wi-Fi, Health
  const reacquire = async (c: Card, e: MouseEvent) => {
    e.stopPropagation()
    if (!caseName || !c.serial) return
    setErr('')
    try {
      await api.deviceImage(caseName, c.name, c.serial)
    } catch (err) {
      setErr((err as Error).message)
    }
  }

  const act = async (c: Card, stage: Stage) => {
    if (!caseName) return
    setErr('')
    try {
      if (stage === 'imaged' || stage === 'partial' || stage === 'error') {
        await api.deviceExtract(caseName, c.name)
      } else if (stage === 'done') {
        navigate(`/cases/${encodeURIComponent(caseName)}?device=${encodeURIComponent(c.name)}`)
      }
    } catch (e) {
      setErr((e as Error).message)
    }
  }

  return (
    <div className="app-bg h-dvh w-full text-ink flex flex-col">
      {/* Header: cùng kiểu thanh menu trang chứng cứ (CaseDetail ROW 1) */}
      <header className="sticky top-0 z-30 shrink-0 bg-[#0a1f44] text-white border-b border-[#081833]">
        <div className="flex h-11 items-center justify-between px-3">
          <div className="flex items-center gap-3 min-w-0">
            <select
              value={caseName}
              onChange={e => pickCase(e.target.value)}
              title="Chọn vụ án / dự án"
              className="inline-flex items-center max-w-[220px] rounded bg-white/10 hover:bg-white/20 text-white px-2 py-1 text-xs font-medium transition-colors cursor-pointer outline-none [&>option]:text-navy"
            >
              {!cases?.length && <option value="">Chưa có vụ án</option>}
              {cases?.map(c => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={openCreate}
              title="Tạo vụ án mới"
              className="inline-flex items-center gap-1 rounded bg-white/10 hover:bg-[#0077cc] text-white px-1.5 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            >
              <Plus size={13} />
            </button>
            <div className="h-4 w-px bg-white/20" />
            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-bold uppercase tracking-wider text-[#00b8ff]">{t('FORENSIC INVESTIGATION')}</span>
              <span className="text-xs text-slate-400">&bull;</span>
              <span className="text-sm font-bold text-white truncate" title={caseName}>{caseName || 'Chưa chọn vụ án'}</span>
            </div>
          </div>

          <div className="flex items-center gap-1.5">
            <button
              type="button"
              disabled={!caseName}
              onClick={openSync}
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 disabled:opacity-40 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>Đồng bộ</span>
            </button>
            <button
              type="button"
              disabled={!caseName}
              onClick={() => navigate(`/cases/${encodeURIComponent(caseName)}`)}
              className="inline-flex items-center gap-1.5 rounded bg-[#0077cc] hover:bg-[#0063ad] disabled:opacity-40 text-white px-2.5 py-1 text-xs font-medium transition-all shadow-xs cursor-pointer"
            >
              <Files size={13} />
              <span>Xem chứng cứ tổng</span>
            </button>
            <span className="inline-flex items-center gap-1.5 rounded bg-white/10 text-white px-2.5 py-1 text-xs font-medium">
              <HardDrive size={13} />
              <span>Thiết bị ({cards.length})</span>
              <span
                className={`ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${usb.length ? 'bg-[#00b8ff]/20 text-[#00b8ff]' : 'bg-white/10 text-slate-400'}`}
                title="Devices connected"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${usb.length ? 'bg-[#00b8ff]' : 'bg-slate-400'}`} aria-hidden="true" />
                {usb.length > 0 ? `Kết nối: ${usb.length}` : 'Không kết nối'}
              </span>
            </span>
            <button
              type="button"
              onClick={() => { logout(); navigate('/login') }}
              title="Sign out"
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-red-500/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ml-1"
            >
              <LogOut size={13} />
              <span>Đăng xuất</span>
            </button>
          </div>
        </div>
      </header>

      {/* Trang vừa 1 màn hình, không cuộn: biểu đồ cao vừa đủ, danh sách thiết bị (2 hàng x 5 cột) giãn lấp phần còn lại;
          cửa sổ quá thấp thì chỉ vùng này cuộn */}
      <main className="flex w-full min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="font-display text-lg font-bold text-white flex items-center gap-2">
              Thống kê
            </h2>
          </div>

          <div className="flex items-center gap-2 text-xs text-slate-300">
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> Đang kết nối cáp USB
            </span>
            <span className="inline-flex items-center gap-1 ml-2">
              <span className="h-2 w-2 rounded-full bg-slate-400" /> Đã rút cáp / Lưu trữ ngoại tuyến
            </span>
          </div>
        </div>

        {cases?.length === 0 && (
          <div className="card mb-5 flex items-center justify-between gap-3 p-4 text-sm text-muted border-amber-200 bg-amber-50">
            <span>Chưa có hồ sơ vụ án nào. Hãy tạo vụ án để bắt đầu quản lý và thu thập thiết bị.</span>
            <button type="button" onClick={openCreate} className={BTN}>
              <FolderPlus className="h-4 w-4" aria-hidden="true" /> Tạo vụ án
            </button>
          </div>
        )}

        {err && (
          <div className="mb-4 flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50 p-3 text-sm text-rose-700" role="alert">
            <AlertTriangle className="h-4 w-4 shrink-0" />
            <span>{err}</span>
          </div>
        )}

        {!cards.length && (
          <div className="card mb-4 p-10 text-center text-muted border-dashed border-2">
            <Smartphone className="mx-auto h-12 w-12 text-muted/40 mb-3" />
            <p className="font-medium text-ink">Chưa có thiết bị nào trong vụ án</p>
            <p className="text-xs text-muted mt-1 max-w-md mx-auto">
              Kết nối điện thoại vào cổng USB của hệ thống, bật chế độ Gỡ lỗi USB (USB Debugging) hoặc tin cậy máy tính (với iOS), hệ thống sẽ tự đóng image (SHA-256) và trích xuất.
            </p>
          </div>
        )}

        {/* Dashboard thống kê vụ án: số máy theo trạng thái + tệp theo loại; bên dưới là danh sách thiết bị */}
        {caseName && (() => {
          const stageOf = (c: Card) => {
            const st = states[`${caseName}\n${c.name}`]
            return { st, stage: ((st && st.stage !== 'new' ? st.stage : c.dev?.stage) ?? 'new') as Stage }
          }
          const all = cards.map(stageOf)
          const totalN = fstat?.n ?? devs.reduce((s, d) => s + d.count, 0)
          const totalSize = fstat?.size ?? devs.reduce((s, d) => s + (d.size ?? 0), 0)
          // 1) vòng tròn: thiết bị theo trạng thái (cùng màu viền thẻ)
          const status = [
            { label: 'Đã trích xuất', color: '#10b981', n: all.filter(x => !x.st?.error && x.stage === 'done').length },
            { label: 'Đã có image', color: '#fbbf24', n: all.filter(x => !x.st?.error && (x.stage === 'imaged' || x.stage === 'partial')).length },
            { label: 'Đang xử lý', color: '#3b82f6', n: all.filter(x => !x.st?.error && (x.stage === 'imaging' || x.stage === 'extracting')).length },
            { label: 'Lỗi', color: '#f43f5e', n: all.filter(x => x.st?.error || x.stage === 'error').length },
            { label: 'Chưa đóng image', color: '#cbd5e1', n: all.filter(x => !x.st?.error && x.stage === 'new').length },
          ].filter(s => s.n)
          let acc = 0
          // 2) cột ngang: tệp theo loại; 3) cột ngang: dung lượng theo thiết bị
          const types = FILE_TYPES.map(t => ({ ...t, n: fstat?.by[t.key]?.n ?? 0, size: fstat?.by[t.key]?.size ?? 0 }))
            .filter(t => t.n).sort((a, b) => b.n - a.n)
          const maxType = Math.max(1, ...types.map(t => t.n))
          const perDev = devs.filter(d => d.count).map(d => ({ name: d.name, size: d.size ?? 0, n: d.count })).sort((a, b) => b.size - a.size)
          const maxDev = Math.max(1, ...perDev.map(d => d.size))
          const H = 'mb-2 flex items-baseline justify-between text-sm font-semibold text-navy'
          const CARD = 'flex flex-col rounded-xl border border-line bg-card p-3 shadow-sm'
          // toàn hệ thống: mọi vụ án (không chỉ vụ đang chọn)
          const sysKpis: [string, string, string][] = [
            ['Vụ án', (cases?.length ?? 0).toLocaleString('vi'), `${(cases ?? []).filter(c => c.count).length} vụ có dữ liệu`],
            ['Thiết bị', (cases ?? []).reduce((s, c) => s + c.device_count, 0).toLocaleString('vi'), 'trên mọi vụ án'],
            ['Tổng tệp', (cases ?? []).reduce((s, c) => s + c.count, 0).toLocaleString('vi'), 'đã trích xuất'],
            ['Ổ lưu trữ', sys ? `${Math.round((100 * sys.disk.used) / sys.disk.total)}%` : '–',
              sys ? `${fmtSize(sys.disk.used)} / ${fmtSize(sys.disk.total)}` : 'đang đọc…'],
          ]
          return (
            <section aria-label="Thống kê" className="mb-4 space-y-3">
              <dl className="grid grid-cols-2 gap-3 lg:grid-cols-4">
                {sysKpis.map(([k, v, sub]) => (
                  <div key={k} className="rounded-xl border border-line bg-card px-5 py-3 shadow-sm">
                    <dt className="text-sm font-medium text-muted">{k}</dt>
                    <dd className="font-display text-3xl font-bold tabular-nums text-navy">{v}</dd>
                    <dd className="mt-0.5 text-xs text-muted">{sub}</dd>
                  </div>
                ))}
              </dl>
              <div className="grid gap-3 lg:grid-cols-3">
              <div className={CARD}>
                <p className={H}><span>Thiết bị theo trạng thái · vụ này</span><span className="text-xs text-muted">{cards.length} máy · {cards.filter(c => c.usb).length} đang cắm</span></p>
                <div className="flex flex-1 items-center justify-around gap-4">
                  <div className="relative h-36 w-36 shrink-0">
                    <svg viewBox="0 0 36 36" className="h-36 w-36 -rotate-90" role="img"
                      aria-label={status.map(s => `${s.label} ${s.n}`).join(', ')}>
                      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="6" stroke="#f1f5f9" />
                      {status.map(s => {
                        const len = (100 * s.n) / cards.length
                        const el = <circle key={s.label} cx="18" cy="18" r="14" fill="none" strokeWidth="6" stroke={s.color}
                          pathLength={100} strokeDasharray={`${len} ${100 - len}`} strokeDashoffset={-acc}><title>{`${s.label}: ${s.n}`}</title></circle>
                        acc += len
                        return el
                      })}
                    </svg>
                    <span className="absolute inset-0 flex flex-col items-center justify-center">
                      <span className="font-display text-3xl font-bold text-navy tabular-nums">{cards.length}</span>
                      <span className="text-xs text-muted">thiết bị</span>
                    </span>
                  </div>
                  <ul className="space-y-2 text-sm text-muted">
                    {!status.length && <li>Chưa có thiết bị</li>}
                    {status.map(s => (
                      <li key={s.label} className="flex items-center gap-1.5">
                        <span className="h-3 w-3 rounded-sm" style={{ background: s.color }} aria-hidden="true" />
                        {s.label} <span className="font-semibold tabular-nums text-ink">{s.n}</span>
                      </li>
                    ))}
                  </ul>
                </div>
              </div>

              <div className={CARD}>
                <p className={H}><span>Tệp theo loại · vụ này</span><span className="text-xs text-muted">{totalN.toLocaleString('vi')} tệp</span></p>
                <ul className="flex flex-1 flex-col justify-between gap-1">
                  {!types.length && <li className="m-auto text-xs text-muted">Chưa có tệp trích xuất</li>}
                  {types.map(t => (
                    <li key={t.key} className="grid grid-cols-[7.5rem_1fr_4rem] items-center gap-2 text-xs"
                      title={`${t.label}: ${t.n.toLocaleString('vi')} tệp · ${fmtSize(t.size)}`}>
                      <span className="truncate text-muted">{t.label}</span>
                      <span className="h-3.5 rounded-full bg-slate-100">
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(1, (100 * t.n) / maxType)}%`, background: t.color }} />
                      </span>
                      <span className="text-right font-semibold tabular-nums text-ink">{t.n.toLocaleString('vi')}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className={CARD}>
                <p className={H}><span>Dung lượng theo thiết bị · vụ này</span><span className="text-xs text-muted">{fmtSize(totalSize)}</span></p>
                {/* 1 dòng/máy (tên | cột | dung lượng) như "Tệp theo loại": khối biểu đồ đủ thấp để trang không cuộn */}
                <ul className="flex flex-1 flex-col justify-around gap-1">
                  {!perDev.length && <li className="m-auto text-xs text-muted">Chưa có dữ liệu thiết bị</li>}
                  {perDev.slice(0, 8).map(d => (
                    <li key={d.name} className="grid grid-cols-[7.5rem_1fr_4rem] items-center gap-2 text-xs"
                      title={`${d.name}: ${fmtSize(d.size)} · ${d.n.toLocaleString('vi')} tệp`}>
                      <span className="truncate text-muted">{d.name}</span>
                      <span className="h-3.5 rounded-full bg-slate-100">
                        <span className="block h-full rounded-full bg-primary" style={{ width: `${Math.max(1, (100 * d.size) / maxDev)}%` }} />
                      </span>
                      <span className="text-right font-semibold tabular-nums text-ink">{fmtSize(d.size)}</span>
                    </li>
                  ))}
                  {perDev.length > 8 && <li className="text-[10px] text-muted">và {perDev.length - 8} thiết bị khác</li>}
                </ul>
              </div>
              </div>
            </section>
          )
        })()}

        {/* Danh sách thiết bị: 20 thẻ/trang = đúng 4 hàng x 5 cột, chia đều chiều cao còn lại; di chuột/focus vào thẻ để xem chi tiết */}
        {cards.length > 0 && (
          <h3 className="mb-2 flex items-baseline gap-2 font-display text-sm font-semibold text-white">
            Danh sách thiết bị của vụ án <span className="text-[#00b8ff]">{caseName}</span>
            <span className="text-xs font-normal text-slate-300">({cards.length})</span>
          </h3>
        )}
        <div className="grid flex-1 grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5 lg:grid-rows-[repeat(4,1fr)]">
          {cards.slice(pg * PAGE, (pg + 1) * PAGE).map((c, i) => {
            const st = states[`${caseName}\n${c.name}`]
            const stage: Stage = (st && st.stage !== 'new' ? st.stage : c.dev?.stage) ?? 'new'
            const isBusy = stage === 'imaging' || stage === 'extracting'
            const openable = stage === 'done' || stage === 'extracting' // đang trích xuất vẫn bấm vào xem phần đã trích được
            const unplugged = stage === 'new' && !c.usb
            const imageName = c.dev?.image_name || st?.image_name
            const serialDisplay = c.dev?.info?.serial || c.serial || c.usb?.serial || c.dev?.serial || null
            const isIos = c.usb ? !!c.usb.ios : (c.name.toLowerCase().includes('iphone') || c.name.toLowerCase().includes('ipad'))
            const cfg = STAGE_CONFIG[stage]
            // đóng image lỗi (stage quay về 'new' kèm lỗi) cũng viền đỏ như trích xuất lỗi
            // lần chạy gần nhất lỗi (vd không kết nối được thiết bị) thì viền đỏ, kể cả máy đã trích xuất xong từ trước
            const border = st?.error ? STAGE_CONFIG.error.borderCls : cfg.borderCls
            const statusText = (st?.phase === 'ai' && stage === 'done' ? `Đã trích xuất · AI phân tích nền ${st.pct}%` : cfg.label) +
              (stage === 'partial' && c.dev?.raw_count ? ` · ${c.dev.count.toLocaleString('vi')}/${c.dev.raw_count.toLocaleString('vi')} tệp` : '')
            const inf: DeviceInfo = c.dev?.info ?? {}
            const used = inf.storage_total ? inf.storage_total - (inf.storage_free ?? 0) : 0
            // thông tin máy đọc từ dữ liệu đã thu (getprop / ideviceinfo); dòng trống thì ẩn
            const infoRows: [string, string | null | undefined][] = [
              ['Hệ điều hành', [inf.os, inf.patch && `bản vá ${inf.patch}`].filter(Boolean).join(' · ')],
              ['IMEI', inf.imei], ['Số điện thoại', inf.phone], ['Nhà mạng', inf.sim], ['Bản build', inf.build],
            ]

            return (
              <div
                key={c.name}
                tabIndex={0}
                aria-describedby={`dv-detail-${i}`}
                /* trích xuất xong: bấm thẳng vào thẻ (hoặc Enter/Space) để xem chứng cứ, không còn nút riêng */
                role={openable ? 'link' : undefined}
                onClick={openable ? () => act(c, 'done') : undefined}
                onKeyDown={openable ? e => { if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) { e.preventDefault(); act(c, 'done') } } : undefined}
                className={`card group relative flex flex-col justify-center gap-2 rounded-xl border border-l-4 border-line ${border} bg-card p-3 shadow-sm outline-none transition-all duration-150 hover:z-20 hover:shadow-md focus-visible:ring-2 focus-visible:ring-primary/50 focus-within:z-20 ${openable ? 'cursor-pointer' : ''}`}
              >
                {/* Thông tin cơ bản: ảnh/icon, tên, cắm cáp + hệ điều hành */}
                <div className="flex items-center gap-2.5">
                  <div className="flex h-12 w-10 shrink-0 items-center justify-center overflow-hidden rounded-md border border-line bg-slate-50 text-primary">
                    <DeviceThumb
                      name={c.dev?.info?.name || c.usb?.name || c.name.split(' · ')[0]}
                      serial={c.serial}
                      ios={isIos}
                      type={c.usb?.type === 'hdd' || c.dev?.type === 'hdd' ? 'hdd' : undefined}
                    />
                  </div>
                  <div className="min-w-0 flex-1">
                    <h3 className="truncate font-display text-sm font-bold text-navy" title={c.name}>{c.name}</h3>
                    <p className="mt-0.5 flex items-center gap-1.5 text-[11px] text-muted">
                      <span className={`h-2 w-2 shrink-0 rounded-full ${c.usb ? 'bg-emerald-500' : 'bg-slate-400'}`} aria-hidden="true" />
                      {c.usb ? 'Đang cắm' : 'Đã rút cáp'} · {c.usb?.type === 'hdd' || c.dev?.type === 'hdd' ? 'Thẻ nhớ / USB' : isIos ? 'iOS' : 'Android'}
                    </p>
                  </div>
                  {/* vòng tiến độ đóng image / trích xuất ở hàng trên (thay thanh ngang + % trong nhãn) */}
                  {/* chỉ khi đang đóng image / trích xuất; AI chạy nền sau trích xuất không hiện vòng (chỉ ghi % trong khung chi tiết) */}
                  {isBusy && st && (
                    <div className="relative h-9 w-9 shrink-0" role="progressbar" aria-valuenow={st.pct} aria-valuemin={0} aria-valuemax={100} aria-label={`${st.phase === 'ai' ? 'Tiến độ AI' : 'Tiến độ'} ${c.name}`} title={st.log}>
                      <svg viewBox="0 0 36 36" className="h-9 w-9 -rotate-90" aria-hidden="true">
                        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" className="stroke-slate-200" />
                        <circle cx="18" cy="18" r="15" fill="none" strokeWidth="3.5" strokeLinecap="round" pathLength={100} strokeDasharray={`${st.pct} 100`} className="stroke-primary transition-all duration-300" />
                      </svg>
                      <span className="absolute inset-0 flex items-center justify-center text-[9px] font-semibold text-ink">{st.pct}%</span>
                    </div>
                  )}
                  {/* trạng thái: màu viền thẻ; chữ cho trình đọc màn hình và trong khung chi tiết khi di chuột */}
                  <span className="sr-only">{statusText}</span>
                  {st?.error && (
                    <span className="shrink-0 text-rose-600" title="Có lỗi, di chuột vào thẻ để xem">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">Có lỗi</span>
                    </span>
                  )}
                  {stage === 'new' && !unplugged && (() => {
                    const ready = !!(c.usb?.ios || c.usb?.adb === 'device' || (c.usb?.type === 'hdd' && c.usb.size))
                    const why = c.usb?.type === 'hdd' ? 'Chưa có thẻ nhớ trong khe' : 'Bật Gỡ lỗi USB / tin cậy máy tính trên máy'
                    return (
                      <IconBtn disabled={!ready || !caseName} onClick={(e) => startImage(c, e)}
                        label={ready ? `Đóng image ${c.name}` : why} tip={ready ? 'Đóng image' : why}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      </IconBtn>
                    )
                  })()}
                  {/* hành động phụ là icon ở hàng trên (như nút đóng image): thẻ giữ nguyên bố cục, không thêm nút chữ */}
                  {(stage === 'partial' || stage === 'error') && (
                    <IconBtn disabled={!caseName} onClick={() => act(c, stage)} label={`${cfg.btn} ${c.name}`} tip={cfg.btn}>
                      {stage === 'partial'
                        ? <Play className="h-3.5 w-3.5" aria-hidden="true" />
                        : <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />}
                    </IconBtn>
                  )}
                  {isIos && c.usb && c.serial && (stage === 'done' || stage === 'imaged') && (
                    <IconBtn disabled={!caseName} onClick={(e) => reacquire(c, e)} label={`Thu thập lại (backup mã hoá) ${c.name}`}
                      tip="Thu thập lại (backup mã hoá): lấy thêm Keychain, lịch sử Safari, nhật ký cuộc gọi, Wi-Fi, Health. Máy tự tắt mã hoá sau khi xong; dữ liệu cũ giữ nguyên.">
                      <KeyRound className="h-3.5 w-3.5" aria-hidden="true" />
                    </IconBtn>
                  )}
                  {openable && <ChevronRight className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                </div>

                {/* Chi tiết: hiện khi di chuột hoặc focus (bàn phím/chạm) vào thẻ; nằm trong thẻ nên rê chuột lên vẫn giữ.
                    Mở lên trên: khung ẩn treo dưới hàng thẻ cuối kéo dài trang, sinh thanh cuộn.
                    shortcut: cửa sổ quá thấp thì đầu khung có thể bị cắt ở mép trên vùng cuộn; khi đó cần tính hướng mở theo chỗ trống */}
                <div
                  id={`dv-detail-${i}`}
                  onClick={e => e.stopPropagation()}
                  className="invisible absolute bottom-full left-0 right-0 z-20 -mb-px space-y-1.5 rounded-t-xl border border-primary/40 bg-card p-3 text-xs opacity-0 shadow-lg transition-opacity duration-150 group-hover:visible group-hover:opacity-100 group-focus-within:visible group-focus-within:opacity-100"
                >
                  {/* Phần chính: thông tin máy + dung lượng */}
                  <p className="font-display text-[13px] font-semibold text-navy">
                    {inf.name || c.name}
                    {inf.model && inf.model !== inf.name && <span className="font-sans text-[11px] font-normal text-muted"> · {inf.model}</span>}
                  </p>
                  <p className="text-[11px] font-semibold text-ink">{statusText}</p>
                  {!inf.name && <p className="text-[10px] italic text-muted">Thông tin máy có sau khi đóng image</p>}
                  {infoRows.filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-2 text-muted">
                      <span className="shrink-0">{k}</span>
                      <span className="min-w-0 break-words text-right text-ink">{v}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span>Serial</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="truncate font-mono text-[11px] font-semibold text-ink">{serialDisplay ?? 'Chưa rõ'}</span>
                      {serialDisplay && (
                        <button type="button" onClick={() => copyText(serialDisplay, `sn_${c.name}`)} className="shrink-0 text-[10px] text-primary hover:underline">
                          {copiedKey === `sn_${c.name}` ? 'Đã chép' : 'Chép'}
                        </button>
                      )}
                    </span>
                  </div>
                  {c.usb?.usb_id && (
                    <div className="flex items-center justify-between gap-2 text-muted">
                      <span>Cổng USB</span>
                      <span className="font-mono text-[11px] text-ink">{c.usb.usb_id}</span>
                    </div>
                  )}
                  {inf.storage_total ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-muted">
                        <span>Bộ nhớ máy</span>
                        <span className="text-ink">{fmtSize(used)} / {fmtSize(inf.storage_total)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`Đã dùng ${Math.round((100 * used) / inf.storage_total)}% bộ nhớ máy`}>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(100 * used) / inf.storage_total}%` }} />
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span className="flex items-center gap-1"><Files className="h-3 w-3 text-slate-400" aria-hidden="true" /> Dữ liệu trích xuất</span>
                    <span className="font-semibold text-ink">{(() => {
                      if (c.dev?.count && c.dev.raw_count) return `${fmtSize(c.dev.size ?? 0)} · ${c.dev.count.toLocaleString('vi')} / ${c.dev.raw_count.toLocaleString('vi')} tệp (dở)`
                      if (c.dev?.count) return `${fmtSize(c.dev.size ?? 0)} · ${c.dev.count.toLocaleString('vi')} tệp`
                      if (c.dev?.raw_size) return `${fmtSize(c.dev.raw_size)} · ${(c.dev.raw_count ?? 0).toLocaleString('vi')} tệp (chờ trích xuất)`
                      const e = c.serial ? est[c.serial] : undefined
                      if (e === null) return 'Đang ước tính…'
                      if (e && 'error' in e) return <span className="text-danger">Không đọc được máy</span>
                      if (e) return `Dự kiến ~${fmtSize(e.bytes)}${e.files != null ? ` · ${e.files} tệp` : ''}`
                      return '0 B · 0 tệp'
                    })()}</span>
                  </div>
                  {stage === 'partial' && c.dev?.raw_size ? (
                    <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-800">
                      Đã thu về {fmtSize(c.dev.raw_size)} · {(c.dev.raw_count ?? 0).toLocaleString('vi')} tệp (image nguyên vẹn). Lần trích xuất trước bị ngắt
                      {c.dev.index_run?.message ? ` (${c.dev.index_run.message})` : ''}; bấm Tiếp tục để lập chỉ mục phần còn lại.
                    </p>
                  ) : null}
                  {(() => {
                    const e = c.serial && !c.dev?.count && !c.dev?.raw_size ? est[c.serial] : undefined
                    return e && 'error' in e ? (
                      <p className="rounded-md border border-amber-200 bg-amber-50 px-2 py-1.5 text-[10px] leading-snug text-amber-800">{e.error}</p>
                    ) : null
                  })()}
                  <hr className="border-line" />
                  {imageName && (
                    <div className="flex items-center justify-between gap-2 text-muted">
                      <span className="flex shrink-0 items-center gap-1"><HardDrive className="h-3 w-3 text-slate-400" aria-hidden="true" /> Tệp image</span>
                      <span className="truncate font-mono text-[11px] text-ink" title={imageName}>{imageName}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span className="flex items-center gap-1"><Layers className="h-3 w-3 text-slate-400" aria-hidden="true" /> Tiếp nhận</span>
                    <span className="text-ink">{formatDateTime(c.dev?.created_at)}</span>
                  </div>
                  {isBusy && st && (
                    <div className="space-y-0.5 text-[10px] text-muted">
                      <div className="flex justify-between"><span>{st.files} tệp</span><span>{fmtSize(st.bytes)}</span></div>
                      {st.log && <p className="truncate font-mono" title={st.log}>{st.log}</p>}
                    </div>
                  )}
                  {st?.error && (
                    <p className="flex items-start gap-1.5 rounded-md border border-rose-200 bg-rose-50 p-2 text-[11px] text-rose-700">
                      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
                      <span className="break-words">{st.error}</span>
                    </p>
                  )}
                </div>
              </div>
            )
          })}
        </div>

        {pages > 1 && (
          <nav className="mt-4 flex items-center justify-center gap-1 text-sm" aria-label="Phân trang thiết bị">
            <button type="button" onClick={() => setPage(pg - 1)} disabled={pg === 0} aria-label="Trang trước"
              className="rounded-md border border-white/20 p-1.5 text-white hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent">
              <ChevronLeft className="h-4 w-4" aria-hidden="true" />
            </button>
            {Array.from({ length: pages }, (_, n) => (
              <button key={n} type="button" onClick={() => setPage(n)} aria-current={n === pg ? 'page' : undefined}
                className={`min-w-8 rounded-md border px-2 py-1 font-medium ${n === pg ? 'border-primary bg-primary text-white' : 'border-white/20 text-white hover:bg-white/10'}`}>
                {n + 1}
              </button>
            ))}
            <button type="button" onClick={() => setPage(pg + 1)} disabled={pg === pages - 1} aria-label="Trang sau"
              className="rounded-md border border-white/20 p-1.5 text-white hover:bg-white/10 disabled:opacity-40 disabled:hover:bg-transparent">
              <ChevronRight className="h-4 w-4" aria-hidden="true" />
            </button>
            <span className="ml-2 text-xs text-slate-300">{pg * PAGE + 1}–{Math.min((pg + 1) * PAGE, cards.length)} / {cards.length} thiết bị</span>
          </nav>
        )}
      </main>

      {/* Dialog tạo vụ án mới */}
      <dialog ref={dlg} aria-labelledby="new-case-title" onClick={closeOnBackdrop} className={DLG}>
        <form onSubmit={create} noValidate className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
            <h2 id="new-case-title" className="flex items-center gap-2 font-display text-base font-semibold text-navy">
              <FolderPlus className="h-4 w-4 text-primary" aria-hidden="true" /> Tạo vụ án mới
            </h2>
            <button type="button" onClick={() => dlg.current?.close()} aria-label="Đóng" className={CLOSE}>
              <X className="h-4 w-4" />
            </button>
          </div>

          <div>
            <label htmlFor="new-case-name" className="mb-1 block text-sm font-medium text-ink">
              Tên vụ án / Hồ sơ
            </label>
            <input
              ref={nameRef}
              id="new-case-name"
              value={newName}
              onChange={e => setNewName(e.target.value)}
              maxLength={60}
              placeholder="VD: Vu-an-01-2026"
              aria-invalid={!!createErr}
              aria-describedby={createErr ? 'new-case-err' : undefined}
              className={FIELD}
            />
          </div>

          {createErr && (
            <p id="new-case-err" role="alert" className="text-xs text-rose-600 font-medium">
              {createErr}
            </p>
          )}

          <p className="text-xs text-muted leading-relaxed">
            Vụ án mới sẽ tự động được chọn làm vụ đang làm việc. Thiết bị sẽ được thêm vào vụ án khi cắm máy.
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={() => dlg.current?.close()} className={BTN2}>
              Hủy
            </button>
            <button type="submit" disabled={busyCreating} className={BTN}>
              {busyCreating ? 'Đang tạo…' : 'Tạo vụ án'}
            </button>
          </div>
        </form>
      </dialog>

      {/* Đồng bộ vụ án: chọn thiết bị đã đóng image -> hàng chờ gửi lên hệ thống trung tâm */}
      <dialog ref={syncDlg} aria-labelledby="sync-title" onClick={closeOnBackdrop} className={DLG}>
        {(() => {
          const inCase = cards.filter(c => c.dev)
          const okNames = inCase.filter(c => c.dev?.image_name).map(c => c.dev?.name ?? c.name)
          return (
            <div className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
                <h2 id="sync-title" className="flex min-w-0 items-center gap-2 font-display text-base font-semibold text-navy">
                  <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate">Đồng bộ vụ án {caseName}</span>
                </h2>
                <button type="button" onClick={() => syncDlg.current?.close()} aria-label="Đóng" className={CLOSE}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                Chọn thiết bị để gửi bản image (kèm SHA-256) và thông tin thiết bị lên hệ thống trung tâm.
              </p>
              <label className="flex items-center gap-2 text-sm font-medium text-ink">
                <input
                  type="checkbox"
                  disabled={!okNames.length}
                  checked={okNames.length > 0 && okNames.every(n => syncSel.has(n))}
                  onChange={e => setSyncSel(new Set(e.target.checked ? okNames : []))}
                  className="h-4 w-4 accent-primary"
                />
                Chọn tất cả ({okNames.length} thiết bị có image)
              </label>
              <fieldset className="max-h-72 space-y-1.5 overflow-y-auto">
                <legend className="sr-only">Thiết bị trong vụ án</legend>
                {!inCase.length && <p className="text-sm text-muted">Vụ án chưa có thiết bị</p>}
                {inCase.map(c => {
                  const name = c.dev?.name ?? c.name
                  const ok = !!c.dev?.image_name
                  const s = syncs[name]
                  return (
                    <label
                      key={name}
                      className={`flex items-center gap-3 rounded-lg border border-line px-3 py-2 text-sm ${ok ? 'cursor-pointer hover:bg-hover' : 'cursor-not-allowed opacity-60'}`}
                    >
                      <input
                        type="checkbox"
                        disabled={!ok}
                        checked={syncSel.has(name)}
                        onChange={() => toggleSync(name)}
                        className="h-4 w-4 shrink-0 accent-primary"
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate font-medium text-ink">{name}</span>
                        <span className="block truncate text-xs text-muted">{ok ? c.dev?.image_name : 'Chưa đóng image'}</span>
                      </span>
                      {s && (
                        <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${SYNC_CLS[s.status]}`}>
                          {SYNC_LABEL[s.status]}
                        </span>
                      )}
                    </label>
                  )
                })}
              </fieldset>
              <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
                Chưa kết nối hệ thống trung tâm: thiết bị được đưa vào hàng chờ và sẽ gửi khi cấu hình kết nối xong.
              </p>
              {syncMsg && <p role="status" className="text-xs font-medium text-ink">{syncMsg}</p>}
              <div className="flex justify-end gap-2 border-t border-line pt-2">
                <button type="button" onClick={() => syncDlg.current?.close()} className={BTN2}>
                  Đóng
                </button>
                <button type="button" disabled={!syncSel.size || syncBusy} onClick={doSync} className={BTN}>
                  <RefreshCw className={`h-4 w-4 ${syncBusy ? 'animate-spin' : ''}`} aria-hidden="true" />
                  {syncBusy ? 'Đang xử lý…' : `Đồng bộ (${syncSel.size})`}
                </button>
              </div>
            </div>
          )
        })()}
      </dialog>
    </div>
  )
}
