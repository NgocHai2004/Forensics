import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, MouseEvent, ReactNode } from 'react'
import { useNavigate } from 'react-router-dom'
import {
  FolderPlus,
  X,
  ChevronLeft,
  ChevronRight,
  ChevronDown,
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
  RefreshCw,
  ShieldCheck,
  Shield,
  ShieldAlert,
  ShieldOff,
  History,
  Pencil,
  Trash2,
  CheckCircle2
} from 'lucide-react'
import { logout } from '../auth'
import { DeviceThumb } from '../components/DeviceThumb'
import { useI18n } from '../i18n'
import { api, ApiError, fmtSize } from '../api'
import type { AuditEntry, Case, Device, FileItem, DeviceAcqState, DeviceInfo, SystemStats, SyncItem } from '../api'

type Usb = Awaited<ReturnType<typeof api.usb>>['items'][number]
type Stage = DeviceAcqState['stage']
type Card = { name: string; serial: string | null; usb?: Usb; dev?: Device }

const STAGE_CONFIG: Record<
  Stage,
  { label: string; enLabel: string; btn: string; enBtn: string; borderCls: string }
> = {
  // màu vạch trái của thẻ thay cho nhãn (viền ngoài để xám nhạt): vàng = đã có image, xanh dương = đang chạy, xanh lá = xong, đỏ = lỗi
  new: { label: 'Chưa đóng image', enLabel: 'Not imaged yet', btn: 'Đóng image & Hash SHA-256', enBtn: 'Create Image & SHA-256', borderCls: 'border-l-line' },
  imaging: { label: 'Đang đóng image…', enLabel: 'Creating image…', btn: 'Đang đóng image…', enBtn: 'Creating image…', borderCls: 'border-l-blue-500' },
  imaged: { label: 'Đã có image + hash', enLabel: 'Imaged + hashed', btn: 'Bắt đầu trích xuất', enBtn: 'Start Extraction', borderCls: 'border-l-amber-400' },
  partial: { label: 'Trích xuất dở (bị ngắt)', enLabel: 'Partial extraction', btn: 'Tiếp tục trích xuất', enBtn: 'Resume Extraction', borderCls: 'border-l-amber-400' },
  extracting: { label: 'Đang trích xuất…', enLabel: 'Extracting…', btn: 'Đang trích xuất…', enBtn: 'Extracting…', borderCls: 'border-l-blue-500' },
  done: { label: 'Trích xuất hoàn tất', enLabel: 'Extraction complete', btn: 'Xem chứng cứ vụ án', enBtn: 'View Case Evidence', borderCls: 'border-l-emerald-500' },
  error: { label: 'Lỗi trích xuất', enLabel: 'Extraction error', btn: 'Trích xuất lại', enBtn: 'Retry Extraction', borderCls: 'border-l-rose-500' },
}

const CASE_KEY = 'mf_case'
// loại tệp cho dashboard: cùng key/màu với STORE ở CaseDetail.tsx và _STORE_SQL ở main.py
const FILE_TYPES = [
  { key: 'image', label: 'Hình ảnh', en: 'Images', color: '#2a78d6' },
  { key: 'video', label: 'Video', en: 'Videos', color: '#eb6834' },
  { key: 'audio', label: 'Âm thanh', en: 'Audio', color: '#1baf7a' },
  { key: 'document', label: 'Tài liệu', en: 'Documents', color: '#eda100' },
  { key: 'chat', label: 'Tin nhắn', en: 'Messages', color: '#0ea5e9' },
  { key: 'archive', label: 'Tệp nén', en: 'Archives', color: '#e87ba4' },
  { key: 'apk', label: 'Tệp cài đặt', en: 'Installers', color: '#008300' },
  { key: 'appdata', label: 'Dữ liệu ứng dụng', en: 'App Data', color: '#6250d6' },
  { key: 'system', label: 'Hệ thống', en: 'System', color: '#e34948' },
  { key: 'other', label: 'Khác', en: 'Other', color: '#9ca3af' },
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
  const { lang, t, theme } = useI18n()
  const isVi = lang === 'vi'
  const L = (vi: string, en: string) => (isVi ? vi : en)
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
  const auditDlg = useRef<HTMLDialogElement>(null)
  const [auditItems, setAuditItems] = useState<AuditEntry[]>([])
  const [auditBusy, setAuditBusy] = useState(false)
  const [auditOnlyCase, setAuditOnlyCase] = useState(true)
  const loadAudit = () => {
    setAuditBusy(true)
    api.audit(100).then(setAuditItems).catch(() => setAuditItems([])).finally(() => setAuditBusy(false))
  }
  const openAudit = () => { loadAudit(); auditDlg.current?.showModal() }
  const renameDlg = useRef<HTMLDialogElement>(null)
  const [renamingDev, setRenamingDev] = useState<string | null>(null)
  const [renameVal, setRenameVal] = useState('')
  const [renameErr, setRenameErr] = useState('')
  const [renameBusy, setRenameBusy] = useState(false)
  const [renameConfirm, setRenameConfirm] = useState(false)
  const delDlg = useRef<HTMLDialogElement>(null)
  const [deletingDev, setDeletingDev] = useState<string | null>(null)
  const [delErr, setDelErr] = useState('')
  const [delBusy, setDelBusy] = useState(false)
  const [toast, setToast] = useState<string | null>(null)
  const showToast = (msg: string) => {
    setToast(msg)
    setTimeout(() => setToast(cur => (cur === msg ? null : cur)), 3500)
  }

  const openRename = (devName: string, e: MouseEvent) => {
    e.stopPropagation()
    setRenamingDev(devName)
    setRenameVal(devName)
    setRenameErr('')
    setRenameConfirm(false)
    renameDlg.current?.showModal()
  }
  const submitRename = async (e: FormEvent) => {
    e.preventDefault()
    if (!caseName || !renamingDev) return
    const next = renameVal.trim()
    if (!next) { setRenameErr(L('Nhập tên thiết bị', 'Enter device name')); return }
    if (next === renamingDev) { setRenameErr(L('Tên mới trùng với tên hiện tại', 'New name is identical to current name')); return }
    if (!renameConfirm) { setRenameConfirm(true); return }
    setRenameBusy(true); setRenameErr('')
    try {
      await api.renameDevice(caseName, renamingDev, next)
      renameDlg.current?.close()
      api.devices(caseName).then(r => setDevs(r.items)).catch(() => {})
      showToast(L(`Đã đổi tên thiết bị "${renamingDev}" thành "${next}"`, `Renamed device "${renamingDev}" to "${next}"`))
    } catch (x) {
      setRenameErr(x instanceof ApiError ? x.message : L('Không đổi tên được thiết bị', 'Cannot rename device'))
    } finally { setRenameBusy(false) }
  }
  const openDelete = (devName: string, e: MouseEvent) => {
    e.stopPropagation()
    setDeletingDev(devName)
    setDelErr('')
    delDlg.current?.showModal()
  }
  const confirmDelete = async () => {
    if (!caseName || !deletingDev) return
    setDelBusy(true); setDelErr('')
    try {
      await api.deleteDevice(caseName, deletingDev)
      delDlg.current?.close()
      api.devices(caseName).then(r => setDevs(r.items)).catch(() => {})
      showToast(L(`Đã xoá thiết bị "${deletingDev}" khỏi vụ án`, `Deleted device "${deletingDev}" from case`))
    } catch (x) {
      setDelErr(x instanceof ApiError ? x.message : L('Không xoá được thiết bị', 'Cannot delete device'))
    } finally { setDelBusy(false) }
  }
  const [syncSel, setSyncSel] = useState<Set<string>>(new Set())
  const [syncs, setSyncs] = useState<Record<string, SyncItem>>({})
  const [syncBusy, setSyncBusy] = useState(false)
  const [syncMsg, setSyncMsg] = useState('')
  const byDevice = (items: SyncItem[]) => Object.fromEntries(items.filter(s => s.status !== 'skipped').map(s => [s.device, s]))

  const [syncExpand, setSyncExpand] = useState<string | null>(null)
  const [syncFiles, setSyncFiles] = useState<Record<string, FileItem[]>>({})
  const [syncFilesBusy, setSyncFilesBusy] = useState<string | null>(null)
  const [syncFileSel, setSyncFileSel] = useState<Record<string, Set<number>>>({})

  const openSync = () => {
    setSyncSel(new Set())
    setSyncMsg('')
    setSyncExpand(null)
    setSyncFiles({})
    setSyncFileSel({})
    api.syncs(caseName).then(r => setSyncs(byDevice(r.items))).catch(() => setSyncs({}))
    syncDlg.current?.showModal()
  }

  const toggleSync = (name: string) => setSyncSel(s => {
    const n = new Set(s)
    if (!n.delete(name)) n.add(name)
    return n
  })

  const toggleExpandSync = async (name: string) => {
    if (syncExpand === name) { setSyncExpand(null); return }
    setSyncExpand(name)
    if (!syncFiles[name]) {
      setSyncFilesBusy(name)
      try {
        const res = await api.files({ collection: caseName, device: name, limit: 100 })
        setSyncFiles(m => ({ ...m, [name]: res.items }))
        setSyncFileSel(m => ({ ...m, [name]: new Set(res.items.map(f => f.id)) }))
      } catch {
        setSyncFiles(m => ({ ...m, [name]: [] }))
      } finally {
        setSyncFilesBusy(null)
      }
    }
  }

  const toggleSyncFile = (devName: string, fileId: number) => {
    setSyncFileSel(m => {
      const cur = new Set(m[devName] ?? [])
      if (!cur.delete(fileId)) cur.add(fileId)
      if (cur.size > 0) setSyncSel(s => new Set(s).add(devName))
      return { ...m, [devName]: cur }
    })
  }

  const toggleAllSyncFiles = (devName: string, checked: boolean) => {
    const list = syncFiles[devName] ?? []
    setSyncFileSel(m => ({ ...m, [devName]: new Set(checked ? list.map(f => f.id) : []) }))
    if (checked && list.length) setSyncSel(s => new Set(s).add(devName))
  }

  const doSync = async () => {
    setSyncBusy(true)
    setSyncMsg('')
    try {
      const filesMap: Record<string, number[]> = {}
      for (const dev of syncSel) {
        if (syncFileSel[dev]) filesMap[dev] = [...syncFileSel[dev]]
      }
      const r = await api.syncQueue(caseName, [...syncSel], Object.keys(filesMap).length ? filesMap : undefined)
      setSyncs(m => ({ ...m, ...byDevice(r.items) }))
      setSyncSel(new Set())
      const queued = r.items.filter(s => s.status !== 'skipped').length
      setSyncMsg(L(`Đã đưa ${queued} thiết bị vào hàng chờ đồng bộ`, `Queued ${queued} device(s) for sync`)
        + (queued < r.items.length ? L(`; bỏ qua ${r.items.length - queued} máy chưa đóng image`, `; skipped ${r.items.length - queued} unimaged device(s)`) : ''))
    } catch (e) {
      setSyncMsg((e as Error).message)
    } finally {
      setSyncBusy(false)
    }
  }

  const create = async (e: FormEvent) => {
    e.preventDefault()
    if (!newName.trim()) { setCreateErr(L('Nhập tên vụ án', 'Enter case name')); return }
    setBusyCreating(true)
    setCreateErr('')
    try {
      const c = await api.createCase(newName.trim())
      setCases(cs => [c, ...(cs ?? [])])
      pickCase(c.name)
      dlg.current?.close()
    } catch (e) {
      setCreateErr(e instanceof ApiError ? e.message : L('Không gọi được máy chủ', 'Cannot reach server'))
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
    <div className={`${theme === 'dark' ? 'app-bg' : theme === 'light' ? 'app-bg-light' : 'bg-canvas'} h-dvh w-full text-ink flex flex-col`}>
      {/* Header: cùng kiểu thanh menu trang chứng cứ (CaseDetail ROW 1) */}
      <header className="sticky top-0 z-30 shrink-0 bg-[#0a1f44] text-white border-b border-[#081833]">
        <div className="flex h-11 items-center justify-between px-3">
          <div className="flex items-center gap-3 min-w-0">
            <select
              value={caseName}
              onChange={e => pickCase(e.target.value)}
              title={L("Chọn vụ án / dự án", "Select case / project")}
              className="inline-flex items-center max-w-[220px] rounded bg-white/10 hover:bg-white/20 text-white px-2 py-1 text-xs font-medium transition-colors cursor-pointer outline-none [&>option]:text-navy"
            >
              {!cases?.length && <option value="">{L("Chưa có vụ án", "No cases yet")}</option>}
              {cases?.map(c => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={openCreate}
              title={L("Tạo vụ án mới", "Create new case")}
              className="inline-flex items-center gap-1 rounded bg-white/10 hover:bg-[#0077cc] text-white px-1.5 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            >
              <Plus size={13} />
            </button>
            <div className="h-4 w-px bg-white/20" />
            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-bold uppercase tracking-wider text-[#00b8ff]">{t('FORENSIC INVESTIGATION')}</span>
              <span className="text-xs text-slate-400">&bull;</span>
              <span className="sensitive text-sm font-bold text-white truncate" title={caseName}>{caseName || L('Chưa chọn vụ án', 'No case selected')}</span>
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
              <span>{L('Đồng bộ', 'Sync')}</span>
            </button>
            <button
              type="button"
              disabled={!caseName}
              onClick={() => navigate(`/cases/${encodeURIComponent(caseName)}`)}
              className="inline-flex items-center gap-1.5 rounded bg-[#0077cc] hover:bg-[#0063ad] disabled:opacity-40 text-white px-2.5 py-1 text-xs font-medium transition-all shadow-xs cursor-pointer"
            >
              <Files size={13} />
              <span>{L('Xem chứng cứ tổng', 'View All Evidence')}</span>
            </button>
            <span className="inline-flex items-center gap-1.5 rounded bg-white/10 text-white px-2.5 py-1 text-xs font-medium">
              <HardDrive size={13} />
              <span>{L('Thiết bị', 'Devices')} ({cards.length})</span>
              <span
                className={`ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${usb.length ? 'bg-[#00b8ff]/20 text-[#00b8ff]' : 'bg-white/10 text-slate-400'}`}
                title="Devices connected"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${usb.length ? 'bg-[#00b8ff] animate-pulse' : 'bg-slate-400'}`} aria-hidden="true" />
                {usb.length > 0 ? `${L('Kết nối', 'Connected')}: ${usb.length}` : L('Không kết nối', 'No connection')}
              </span>
            </span>
            <button
              type="button"
              onClick={openAudit}
              title={L('Nhật ký hoạt động vụ án', 'Case activity log')}
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <History size={13} aria-hidden="true" />
              <span>{L('Nhật ký vụ án', 'Case Log')}</span>
            </button>
            <button
              type="button"
              onClick={() => { logout(); navigate('/login') }}
              title="Sign out"
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-red-500/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ml-1"
            >
              <LogOut size={13} />
              <span>{L('Đăng xuất', 'Sign out')}</span>
            </button>
          </div>
        </div>
      </header>

      {/* Trang vừa 1 màn hình, không cuộn: biểu đồ cao vừa đủ, danh sách thiết bị (2 hàng x 5 cột) giãn lấp phần còn lại;
          cửa sổ quá thấp thì chỉ vùng này cuộn */}
      <main className="flex w-full min-h-0 flex-1 flex-col overflow-y-auto px-4 sm:px-6 lg:px-8 py-3">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className={`font-display text-lg font-bold flex items-center gap-2 ${theme === 'dark' ? 'text-white' : 'text-navy'}`}>
              {L('Thống kê', 'Statistics')}
            </h2>
          </div>

          <div className={`flex items-center gap-2 text-xs ${theme === 'dark' ? 'text-slate-300' : 'text-muted'}`}>
            <span className="inline-flex items-center gap-1">
              <span className="h-2 w-2 rounded-full bg-emerald-500" /> {L('Đang kết nối cáp USB', 'USB Connected')}
            </span>
            <span className="inline-flex items-center gap-1 ml-2">
              <span className="h-2 w-2 rounded-full bg-slate-400" /> {L('Đã rút cáp / Lưu trữ ngoại tuyến', 'Disconnected / Offline')}
            </span>
          </div>
        </div>

        {cases?.length === 0 && (
          <div className="card mb-5 flex items-center justify-between gap-3 p-4 text-sm text-muted border-amber-200 bg-amber-50">
            <span>{L('Chưa có hồ sơ vụ án nào. Hãy tạo vụ án để bắt đầu quản lý và thu thập thiết bị.', 'No case records yet. Create a case to start managing and acquiring devices.')}</span>
            <button type="button" onClick={openCreate} className={BTN}>
              <FolderPlus className="h-4 w-4" aria-hidden="true" /> {L("Tạo vụ án", "Create Case")}
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
            <p className="font-medium text-ink">{L("Chưa có thiết bị nào trong vụ án", "No devices in this case yet")}</p>
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
            { label: L('Đã trích xuất', 'Extracted'), color: '#00b8ff', n: all.filter(x => !x.st?.error && x.stage === 'done').length },
            { label: L('Đã có image', 'Imaged'), color: '#fbbf24', n: all.filter(x => !x.st?.error && (x.stage === 'imaged' || x.stage === 'partial')).length },
            { label: L('Đang xử lý', 'Processing'), color: '#3b82f6', n: all.filter(x => !x.st?.error && (x.stage === 'imaging' || x.stage === 'extracting')).length },
            { label: L('Lỗi', 'Error'), color: '#f43f5e', n: all.filter(x => x.st?.error || x.stage === 'error').length },
            { label: L('Chưa đóng image', 'Not imaged'), color: '#cbd5e1', n: all.filter(x => !x.st?.error && x.stage === 'new').length },
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
            [L('Vụ án', 'Cases'), (cases?.length ?? 0).toLocaleString(isVi ? 'vi' : 'en'), `${(cases ?? []).filter(c => c.count).length} ${L('vụ có dữ liệu', 'cases with data')}`],
            [L('Thiết bị', 'Devices'), (cases ?? []).reduce((s, c) => s + c.device_count, 0).toLocaleString(isVi ? 'vi' : 'en'), L('trên mọi vụ án', 'across all cases')],
            [L('Tổng tệp', 'Total Files'), (cases ?? []).reduce((s, c) => s + c.count, 0).toLocaleString(isVi ? 'vi' : 'en'), L('đã trích xuất', 'extracted')],
            [L('Ổ lưu trữ', 'Storage'), sys ? `${Math.round((100 * sys.disk.used) / sys.disk.total)}%` : '–',
              sys ? `${fmtSize(sys.disk.used)} / ${fmtSize(sys.disk.total)}` : L('đang đọc…', 'reading…')],
          ]
          return (
            <section aria-label={L("Thống kê", "Statistics")} className="mb-4 space-y-3">
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
                <p className={H}><span>{L('Thiết bị theo trạng thái · vụ này', 'Devices by Status · This Case')}</span><span className="text-xs text-muted">{cards.length} {L('máy', 'devices')} · {cards.filter(c => c.usb).length} {L('đang cắm', 'connected')}</span></p>
                <div className="flex flex-1 items-center justify-around gap-4">
                  <div className="relative h-36 w-36 shrink-0">
                    <svg viewBox="0 0 36 36" className="h-36 w-36 -rotate-90" role="img"
                      aria-label={status.map(s => `${s.label} ${s.n}`).join(', ')}>
                      <circle cx="18" cy="18" r="14" fill="none" strokeWidth="6" stroke="rgb(255 255 255 / 0.08)" />
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
                      <span className="text-xs text-muted">{L("thiết bị", "devices")}</span>
                    </span>
                  </div>
                  <ul className="space-y-2 text-sm text-muted">
                    {!status.length && <li>{L('Chưa có thiết bị', 'No devices')}</li>}
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
                <p className={H}><span>{L('Tệp theo loại · vụ này', 'Files by Type · This Case')}</span><span className="text-xs text-muted">{totalN.toLocaleString(isVi ? 'vi' : 'en')} {L('tệp', 'files')}</span></p>
                <ul className="flex flex-1 flex-col justify-between gap-1">
                  {!types.length && <li className="m-auto text-xs text-muted">{L('Chưa có tệp trích xuất', 'No extracted files yet')}</li>}
                  {types.map(t => (
                    <li key={t.key} className="grid grid-cols-[7.5rem_1fr_4rem] items-center gap-2 text-xs"
                      title={`${t.label}: ${t.n.toLocaleString('vi')} tệp · ${fmtSize(t.size)}`}>
                      <span className="truncate text-muted">{isVi ? t.label : t.en}</span>
                      <span className="h-3.5 rounded-full bg-slate-100">
                        <span className="block h-full rounded-full" style={{ width: `${Math.max(1, (100 * t.n) / maxType)}%`, background: t.color }} />
                      </span>
                      <span className="text-right font-semibold tabular-nums text-ink">{t.n.toLocaleString('vi')}</span>
                    </li>
                  ))}
                </ul>
              </div>

              <div className={CARD}>
                <p className={H}><span>{L('Dung lượng theo thiết bị · vụ này', 'Storage by Device · This Case')}</span><span className="text-xs text-muted">{fmtSize(totalSize)}</span></p>
                {/* 1 dòng/máy (tên | cột | dung lượng) như "Tệp theo loại": khối biểu đồ đủ thấp để trang không cuộn */}
                <ul className="flex flex-1 flex-col justify-around gap-1">
                  {!perDev.length && <li className="m-auto text-xs text-muted">{L('Chưa có dữ liệu thiết bị', 'No device data yet')}</li>}
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
          <h3 className={`mb-2 flex items-baseline gap-2 font-display text-sm font-semibold ${theme === 'dark' ? 'text-white' : 'text-navy'}`}>
            {L('Danh sách thiết bị của vụ án', 'Case Devices')} <span className="text-[#00b8ff]">{caseName}</span>
            <span className={`text-xs font-normal ${theme === 'dark' ? 'text-slate-300' : 'text-muted'}`}>({cards.length})</span>
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
            const canImage = !!(c.usb?.ios || c.usb?.adb === 'device' || (c.usb?.type === 'hdd' && c.usb.size))
            const cfg = STAGE_CONFIG[stage]
            // đóng image lỗi (stage quay về 'new' kèm lỗi) cũng viền đỏ như trích xuất lỗi
            // lần chạy gần nhất lỗi (vd không kết nối được thiết bị) thì viền đỏ, kể cả máy đã trích xuất xong từ trước
            const border = st?.error ? STAGE_CONFIG.error.borderCls : cfg.borderCls
            const statusText = (st?.phase === 'ai' && stage === 'done' ? L(`Đã trích xuất · AI phân tích nền ${st.pct}%`, `Extracted · AI background ${st.pct}%`) : (isVi ? cfg.label : cfg.enLabel)) +
              (stage === 'partial' && c.dev?.raw_count ? ` · ${c.dev.count.toLocaleString('vi')}/${c.dev.raw_count.toLocaleString('vi')} tệp` : '')
            const inf: DeviceInfo = c.dev?.info ?? {}
            const used = inf.storage_total ? inf.storage_total - (inf.storage_free ?? 0) : 0
            // thông tin máy đọc từ dữ liệu đã thu (getprop / ideviceinfo); dòng trống thì ẩn
            const infoRows: [string, string | null | undefined][] = [
              [L('Hệ điều hành', 'OS'), [inf.os, inf.patch && `${L('bản vá', 'patch')} ${inf.patch}`].filter(Boolean).join(' · ')],
              ['IMEI', inf.imei], [L('Số điện thoại', 'Phone'), inf.phone], [L('Nhà mạng', 'Carrier'), inf.sim], [L('Bản build', 'Build'), inf.build],
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
                {c.usb && <span aria-hidden="true" className="usb-ring" />}
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
                      <span className={`h-2 w-2 shrink-0 rounded-full ${c.usb ? 'bg-emerald-500 animate-pulse' : 'bg-slate-400'}`} aria-hidden="true" />
                      {c.usb ? L('Đang cắm', 'Connected') : L('Đã rút cáp', 'Disconnected')} · {c.usb?.type === 'hdd' || c.dev?.type === 'hdd' ? L('Thẻ nhớ / USB', 'Card / USB') : isIos ? 'iOS' : 'Android'}
                    </p>
                  </div>
                      <span className="group/st relative shrink-0 self-center" onClick={e => e.stopPropagation()}>
                        <button
                          type="button"
                          disabled={!caseName || isBusy || (stage === 'new' && !canImage)}
                          onClick={e => { e.stopPropagation(); act(c, stage) }}
                          aria-label={`${isVi ? cfg.label : cfg.enLabel} — ${isVi ? cfg.btn : cfg.enBtn}`}
                          className={`inline-flex h-8 w-8 items-center justify-center rounded-lg border transition-all duration-150 cursor-pointer disabled:cursor-not-allowed disabled:opacity-50 hover:scale-105 active:scale-95 ${
                            st?.error || stage === 'error'
                              ? 'border-rose-400/45 bg-rose-500/15 text-rose-400 hover:border-rose-300 hover:bg-rose-500/25 hover:shadow-[0_0_12px_rgba(244,63,94,0.45)]'
                              : stage === 'done'
                              ? 'border-[#00b8ff]/55 bg-[#0077cc]/25 text-[#38c8ff] shadow-[0_0_10px_rgba(0,184,255,0.32)] hover:border-[#7de6ff] hover:bg-[#00b8ff]/35 hover:shadow-[0_0_16px_rgba(0,200,255,0.65)]'
                              : stage === 'imaged' || stage === 'partial'
                              ? 'border-amber-400/50 bg-amber-500/15 text-amber-300 hover:border-amber-300 hover:bg-amber-500/25 hover:shadow-[0_0_12px_rgba(251,191,36,0.4)]'
                              : isBusy
                              ? 'border-[#00b8ff]/50 bg-[#0077cc]/20 text-[#38c8ff] animate-pulse'
                              : 'border-slate-400/30 bg-slate-500/10 text-slate-300 hover:border-[#38c8ff] hover:bg-[#00b8ff]/20 hover:text-white hover:shadow-[0_0_12px_rgba(0,184,255,0.45)]'
                          }`}
                        >
                          {st?.error || stage === 'error' ? (
                            <ShieldAlert size={16} />
                          ) : stage === 'done' ? (
                            <ShieldCheck size={16} />
                          ) : stage === 'imaged' || stage === 'partial' || isBusy ? (
                            <Shield size={16} />
                          ) : (
                            <ShieldOff size={16} />
                          )}
                        </button>
                        <span role="tooltip" className="pointer-events-none invisible absolute bottom-full right-0 z-30 mb-1.5 w-max max-w-56 rounded-md border border-[#00b8ff]/40 bg-[#06142e]/95 px-2.5 py-1 text-[11px] font-medium leading-snug text-white opacity-0 shadow-[0_0_14px_rgba(0,184,255,0.35)] transition-opacity duration-100 group-hover/st:visible group-hover/st:opacity-100 group-focus-within/st:visible group-focus-within/st:opacity-100">
                          {st?.error || stage === 'error'
                            ? `${L('Lỗi', 'Error')} · ${L('Bấm để', 'Click to')} ${isVi ? cfg.btn : cfg.enBtn}`
                            : stage === 'done'
                            ? `${L('Đã trích xuất (SHA-256)', 'Extracted (SHA-256)')} · ${L('Bấm để', 'Click to')} ${isVi ? cfg.btn : cfg.enBtn}`
                            : stage === 'imaged' || stage === 'partial'
                            ? `${L('Đã đóng image (SHA-256)', 'Imaged (SHA-256)')} · ${L('Bấm để', 'Click to')} ${isVi ? cfg.btn : cfg.enBtn}`
                            : isBusy
                            ? statusText
                            : canImage
                            ? `${L('Chưa đóng image', 'Not imaged')} · ${L('Bấm để', 'Click to')} ${isVi ? cfg.btn : cfg.enBtn}`
                            : L('Chưa đóng image · Cần cắm cáp & cấp quyền', 'Not imaged · Connect USB & trust device')}
                        </span>
                      </span>
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
                  {c.dev && (
                    <div className="flex shrink-0 items-center gap-1" onClick={e => e.stopPropagation()}>
                      <IconBtn
                        disabled={isBusy}
                        onClick={e => openRename(c.name, e)}
                        label={`${L('Sửa tên', 'Rename')} ${c.name}`}
                        tip={L('Sửa tên thiết bị', 'Rename device')}
                      >
                        <Pencil className="h-3.5 w-3.5" aria-hidden="true" />
                      </IconBtn>
                      <IconBtn
                        disabled={isBusy}
                        onClick={e => openDelete(c.name, e)}
                        label={`${L('Xoá', 'Delete')} ${c.name}`}
                        tip={L('Xoá thiết bị khỏi vụ án', 'Delete device from case')}
                      >
                        <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                      </IconBtn>
                    </div>
                  )}
                  <span className="sr-only">{statusText}</span>
                  {st?.error && (
                    <span className="shrink-0 text-rose-600" title="Có lỗi, di chuột vào thẻ để xem">
                      <AlertTriangle className="h-3.5 w-3.5" aria-hidden="true" />
                      <span className="sr-only">Có lỗi</span>
                    </span>
                  )}
                  {stage === 'new' && !unplugged && (() => {
                    const ready = !!(c.usb?.ios || c.usb?.adb === 'device' || (c.usb?.type === 'hdd' && c.usb.size))
                    const why = c.usb?.type === 'hdd' ? L('Chưa có thẻ nhớ trong khe', 'No memory card inserted') : L('Bật Gỡ lỗi USB / tin cậy máy tính trên máy', 'Enable USB Debugging / Trust Computer on device')
                    return (
                      <IconBtn disabled={!ready || !caseName} onClick={(e) => startImage(c, e)}
                        label={ready ? `${L('Đóng image', 'Create image')} ${c.name}` : why} tip={ready ? L('Đóng image', 'Create image') : why}>
                        <Download className="h-3.5 w-3.5" aria-hidden="true" />
                      </IconBtn>
                    )
                  })()}
                  {/* hành động phụ là icon ở hàng trên (như nút đóng image): thẻ giữ nguyên bố cục, không thêm nút chữ */}
                  {(stage === 'partial' || stage === 'error') && (
                    <IconBtn disabled={!caseName} onClick={() => act(c, stage)} label={`${isVi ? cfg.btn : cfg.enBtn} ${c.name}`} tip={isVi ? cfg.btn : cfg.enBtn}>
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
                  {!inf.name && <p className="text-[10px] italic text-muted">{L("Thông tin máy có sau khi đóng image", "Device info available after imaging")}</p>}
                  {infoRows.filter(([, v]) => v).map(([k, v]) => (
                    <div key={k} className="flex items-start justify-between gap-2 text-muted">
                      <span className="shrink-0">{k}</span>
                      <span className="sensitive min-w-0 break-words text-right font-mono tabular-nums text-ink">{v}</span>
                    </div>
                  ))}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span>Serial</span>
                    <span className="flex min-w-0 items-center gap-1.5">
                      <span className="sensitive truncate font-mono tabular-nums text-[11px] font-semibold text-ink">{serialDisplay ?? L('Chưa rõ', 'Unknown')}</span>
                      {serialDisplay && (
                        <button type="button" onClick={() => copyText(serialDisplay, `sn_${c.name}`)} className="shrink-0 text-[10px] text-primary hover:underline">
                          {copiedKey === `sn_${c.name}` ? L('Đã chép', 'Copied') : L('Chép', 'Copy')}
                        </button>
                      )}
                    </span>
                  </div>
                  {c.usb?.usb_id && (
                    <div className="flex items-center justify-between gap-2 text-muted">
                      <span>{L('Cổng USB', 'USB Port')}</span>
                      <span className="font-mono text-[11px] text-ink">{c.usb.usb_id}</span>
                    </div>
                  )}
                  {inf.storage_total ? (
                    <div className="space-y-1">
                      <div className="flex items-center justify-between gap-2 text-muted">
                        <span>{L('Bộ nhớ máy', 'Device Storage')}</span>
                        <span className="text-ink">{fmtSize(used)} / {fmtSize(inf.storage_total)}</span>
                      </div>
                      <div className="h-1.5 overflow-hidden rounded-full bg-slate-200" role="img" aria-label={`Đã dùng ${Math.round((100 * used) / inf.storage_total)}% bộ nhớ máy`}>
                        <div className="h-full rounded-full bg-primary" style={{ width: `${(100 * used) / inf.storage_total}%` }} />
                      </div>
                    </div>
                  ) : null}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span className="flex items-center gap-1"><Files className="h-3 w-3 text-slate-400" aria-hidden="true" /> {L('Dữ liệu trích xuất', 'Extracted Data')}</span>
                    <span className="font-semibold text-ink">{(() => {
                      if (c.dev?.count && c.dev.raw_count) return `${fmtSize(c.dev.size ?? 0)} · ${c.dev.count.toLocaleString('vi')} / ${c.dev.raw_count.toLocaleString('vi')} tệp (dở)`
                      if (c.dev?.count) return `${fmtSize(c.dev.size ?? 0)} · ${c.dev.count.toLocaleString('vi')} tệp`
                      if (c.dev?.raw_size) return `${fmtSize(c.dev.raw_size)} · ${(c.dev.raw_count ?? 0).toLocaleString('vi')} tệp (chờ trích xuất)`
                      const e = c.serial ? est[c.serial] : undefined
                      if (e === null) return L('Đang ước tính…', 'Estimating…')
                      if (e && 'error' in e) return <span className="text-danger">{L("Không đọc được máy", "Cannot read device")}</span>
                      if (e) return `Dự kiến ~${fmtSize(e.bytes)}${e.files != null ? ` · ${e.files} tệp` : ''}`
                      return L('0 B · 0 tệp', '0 B · 0 files')
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
                      <span className="flex shrink-0 items-center gap-1"><HardDrive className="h-3 w-3 text-slate-400" aria-hidden="true" /> {L('Tệp image', 'Image File')}</span>
                      <span className="truncate font-mono text-[11px] text-ink" title={imageName}>{imageName}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-2 text-muted">
                    <span className="flex items-center gap-1"><Layers className="h-3 w-3 text-slate-400" aria-hidden="true" /> {L('Tiếp nhận', 'Acquired')}</span>
                    <span className="text-ink">{formatDateTime(c.dev?.created_at)}</span>
                  </div>
                  {isBusy && st && (
                    <div className="space-y-0.5 text-[10px] text-muted">
                      <div className="flex justify-between"><span>{st.files} {L('tệp', 'files')}</span><span>{fmtSize(st.bytes)}</span></div>
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
            <span className={`ml-2 text-xs ${theme === 'dark' ? 'text-slate-300' : 'text-muted'}`}>{pg * PAGE + 1}–{Math.min((pg + 1) * PAGE, cards.length)} / {cards.length} thiết bị</span>
          </nav>
        )}
      </main>

      {/* Dialog tạo vụ án mới */}
      <dialog ref={dlg} aria-labelledby="new-case-title" onClick={closeOnBackdrop} className={DLG}>
        <form onSubmit={create} noValidate className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
            <h2 id="new-case-title" className="flex items-center gap-2 font-display text-base font-semibold text-navy">
              <FolderPlus className="h-4 w-4 text-primary" aria-hidden="true" /> {L("Tạo vụ án", "Create Case")} mới
            </h2>
            <button type="button" onClick={() => dlg.current?.close()} aria-label="Đóng" className={CLOSE}>
              <X className="h-4 w-4" />
            </button>
          </div>

          <div>
            <label htmlFor="new-case-name" className="mb-1 block text-sm font-medium text-ink">
              {L('Tên vụ án / Hồ sơ', 'Case / Record Name')}
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
            {L('Vụ án mới sẽ tự động được chọn làm vụ đang làm việc. Thiết bị sẽ được thêm vào vụ án khi cắm máy.', 'The new case will be selected automatically. Devices are added when plugged in.')}
          </p>

          <div className="flex justify-end gap-2 pt-2 border-t border-line">
            <button type="button" onClick={() => dlg.current?.close()} className={BTN2}>
              Hủy
            </button>
            <button type="submit" disabled={busyCreating} className={BTN}>
              {busyCreating ? L('Đang tạo…', 'Creating…') : L('Tạo vụ án', 'Create Case')}
            </button>
          </div>
        </form>
      </dialog>

      {/* Đồng bộ vụ án: chọn thiết bị đã đóng image -> hàng chờ gửi lên hệ thống trung tâm */}
      <dialog ref={syncDlg} aria-labelledby="sync-title" onClick={closeOnBackdrop} className="m-auto w-[min(60rem,calc(100vw-2rem))] max-h-[90vh] rounded-xl bg-card p-0 text-ink shadow-xl backdrop:bg-navy/40">
        {(() => {
          const inCase = cards.filter(c => c.dev)
          const okNames = inCase.filter(c => c.dev?.image_name).map(c => c.dev?.name ?? c.name)
          return (
            <div className="flex flex-col gap-4 p-5">
              <div className="flex items-center justify-between gap-2 border-b border-line pb-3">
                <h2 id="sync-title" className="flex min-w-0 items-center gap-2 font-display text-base font-semibold text-navy">
                  <RefreshCw className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="truncate">{L("Đồng bộ vụ án", "Sync Case")} {caseName}</span>
                </h2>
                <button type="button" onClick={() => syncDlg.current?.close()} aria-label="Đóng" className={CLOSE}>
                  <X className="h-4 w-4" />
                </button>
              </div>
              <p className="text-xs leading-relaxed text-muted">
                {L('Chọn thiết bị để gửi bản image (kèm SHA-256) và thông tin thiết bị lên hệ thống trung tâm.', 'Select devices to send image files (with SHA-256) and device metadata to the central server.')}
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
              <fieldset className="max-h-[52vh] space-y-2 overflow-y-auto pr-1">
                <legend className="sr-only">Thiết bị trong vụ án</legend>
                {!inCase.length && <p className="text-sm text-muted">Vụ án chưa có thiết bị</p>}
                {inCase.map(c => {
                  const name = c.dev?.name ?? c.name
                  const ok = !!c.dev?.image_name
                  const s = syncs[name]
                  const expanded = syncExpand === name
                  const flist = syncFiles[name]
                  const fsel = syncFileSel[name]
                  return (
                    <div key={name} className={`rounded-lg border border-line ${ok ? '' : 'opacity-60'}`}>
                      <div className={`flex items-center gap-3 px-3 py-2 text-sm ${ok ? 'hover:bg-hover' : ''}`}>
                        <input
                          type="checkbox"
                          disabled={!ok}
                          checked={syncSel.has(name)}
                          onChange={() => toggleSync(name)}
                          className="h-4 w-4 shrink-0 accent-primary cursor-pointer disabled:cursor-not-allowed"
                        />
                        <button
                          type="button"
                          onClick={() => toggleExpandSync(name)}
                          className="min-w-0 flex-1 text-left cursor-pointer"
                          title={L('Bấm để chọn tài liệu trong thiết bị', 'Click to select files in device')}
                        >
                          <span className="block truncate font-medium text-ink">{name}</span>
                          <span className="block truncate text-xs text-muted">
                            {ok ? c.dev?.image_name : L('Chưa đóng image', 'Not imaged yet')}
                            {c.dev?.count ? ` · ${c.dev.count.toLocaleString(isVi ? 'vi' : 'en')} ${L('tài liệu', 'files')}` : ''}
                            {fsel ? ` (${L('đã chọn', 'selected')} ${fsel.size})` : ''}
                          </span>
                        </button>
                        {s && (
                          <span className={`shrink-0 rounded px-1.5 py-0.5 text-[11px] font-medium ${(isVi ? SYNC_LABEL[s.status] : ({ pending: 'Pending', sending: 'Sending', done: 'Synced', error: 'Error', skipped: 'Skipped' }[s.status])) ? SYNC_CLS[s.status] : ''}`}>
                            {isVi ? SYNC_LABEL[s.status] : ({ pending: 'Pending', sending: 'Sending', done: 'Synced', error: 'Error', skipped: 'Skipped' }[s.status])}
                          </span>
                        )}
                        <button
                          type="button"
                          onClick={() => toggleExpandSync(name)}
                          aria-label={L('Chọn tài liệu', 'Select files')}
                          className="shrink-0 rounded p-1 text-muted hover:bg-white/10 hover:text-ink cursor-pointer"
                        >
                          <ChevronDown className={`h-4 w-4 transition-transform ${expanded ? 'rotate-180 text-primary' : ''}`} />
                        </button>
                      </div>
                      {expanded && (
                        <div className="border-t border-line bg-black/20 px-3 py-2 text-xs">
                          {syncFilesBusy === name ? (
                            <p className="py-2 text-center text-muted">{L('Đang tải danh sách tài liệu…', 'Loading files…')}</p>
                          ) : !flist?.length ? (
                            <p className="py-2 text-center text-muted">{L('Chưa có tài liệu nào được trích xuất.', 'No extracted files yet.')}</p>
                          ) : (
                            <div className="space-y-1">
                              <label className="flex items-center gap-2 pb-1 border-b border-line/60 font-medium text-ink cursor-pointer">
                                <input
                                  type="checkbox"
                                  checked={flist.length > 0 && flist.every(f => fsel?.has(f.id))}
                                  onChange={e => toggleAllSyncFiles(name, e.target.checked)}
                                  className="h-3.5 w-3.5 accent-primary"
                                />
                                <span>{L('Chọn tất cả tài liệu', 'Select all files')} ({flist.length})</span>
                              </label>
                              <div className="max-h-64 space-y-1 overflow-y-auto pt-1 pr-1">
                                {flist.map(f => (
                                  <label key={f.id} className="flex items-center gap-2 rounded px-1.5 py-1 hover:bg-white/5 cursor-pointer">
                                    <input
                                      type="checkbox"
                                      checked={!!fsel?.has(f.id)}
                                      onChange={() => toggleSyncFile(name, f.id)}
                                      className="h-3.5 w-3.5 shrink-0 accent-primary"
                                    />
                                    <span className="min-w-0 flex-1 truncate text-ink" title={f.name}>{f.name}</span>
                                    <span className="shrink-0 font-mono tabular-nums text-[10.5px] text-muted">{fmtSize(f.size)}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                        </div>
                      )}
                    </div>
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
      {/* Dialog sửa tên thiết bị */}
      <dialog ref={renameDlg} onClick={e => e.target === renameDlg.current && renameDlg.current.close()} className={DLG}>
        <form onSubmit={submitRename} className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-navy">
              <Pencil className="h-4 w-4 text-primary" aria-hidden="true" />
              <span>{L('Đổi tên thiết bị', 'Rename Device')}</span>
            </h2>
            <button type="button" onClick={() => renameDlg.current?.close()} aria-label={L('Đóng', 'Close')} className={CLOSE}><X className="h-4 w-4" /></button>
          </div>
          {!renameConfirm ? (
            <div>
              <label className="mb-1.5 block text-xs font-medium text-muted">{L('Tên thiết bị mới', 'New device name')}</label>
              <input
                type="text"
                value={renameVal}
                onChange={e => { setRenameVal(e.target.value); setRenameErr('') }}
                className={FIELD}
                autoFocus
              />
              {renameErr && <p className="mt-1.5 text-xs text-danger">{renameErr}</p>}
            </div>
          ) : (
            <div className="rounded-lg border border-cyan-400/35 bg-cyan-500/10 p-3 text-sm text-ink leading-relaxed">
              {L('Xác nhận đổi tên thiết bị', 'Confirm renaming device')} <strong className="text-white">{renamingDev}</strong> {L('thành', 'to')} <strong className="text-[#38c8ff]">{renameVal.trim()}</strong>?
              {renameErr && <p className="mt-1.5 text-xs text-danger">{renameErr}</p>}
            </div>
          )}
          <div className="flex justify-end gap-2 pt-1">
            {renameConfirm ? (
              <button type="button" onClick={() => { setRenameConfirm(false); setRenameErr('') }} className={BTN2}>{L('Quay lại', 'Back')}</button>
            ) : (
              <button type="button" onClick={() => renameDlg.current?.close()} className={BTN2}>{L('Hủy', 'Cancel')}</button>
            )}
            <button type="submit" disabled={renameBusy} className={BTN}>
              {renameBusy ? L('Đang lưu…', 'Saving…') : renameConfirm ? L('Xác nhận đổi tên', 'Confirm Rename') : L('Tiếp tục', 'Continue')}
            </button>
          </div>
        </form>
      </dialog>

      {/* Dialog xác nhận xoá thiết bị */}
      <dialog ref={delDlg} onClick={e => e.target === delDlg.current && delDlg.current.close()} className={DLG}>
        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <h2 className="flex items-center gap-2 font-display text-base font-semibold text-rose-400">
              <Trash2 className="h-4 w-4" aria-hidden="true" />
              <span>{L('Xoá thiết bị', 'Delete Device')}</span>
            </h2>
            <button type="button" onClick={() => delDlg.current?.close()} aria-label={L('Đóng', 'Close')} className={CLOSE}><X className="h-4 w-4" /></button>
          </div>
          <p className="text-sm text-ink leading-relaxed">
            {L('Xoá thiết bị', 'Delete device')} <strong className="text-white">{deletingDev}</strong> {L('khỏi vụ án', 'from case')} <strong>{caseName}</strong>? {L('Toàn bộ dữ liệu đã trích xuất của thiết bị này sẽ chuyển vào thùng rác.', 'All extracted data for this device will be moved to trash.')}
          </p>
          {delErr && <p className="text-xs text-danger">{delErr}</p>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => delDlg.current?.close()} className={BTN2}>{L('Hủy', 'Cancel')}</button>
            <button type="button" disabled={delBusy} onClick={confirmDelete} className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-rose-600 hover:bg-rose-500 px-4 text-sm font-medium text-white cursor-pointer disabled:opacity-50">
              {delBusy ? L('Đang xoá…', 'Deleting…') : L('Xoá thiết bị', 'Delete')}
            </button>
          </div>
        </div>
      </dialog>

      {/* Nhật ký vụ án (Audit log) */}
      <dialog ref={auditDlg} onClick={e => e.target === auditDlg.current && auditDlg.current.close()} className={`${DLG} w-[min(42rem,calc(100vw-2rem))]`}>
        <div className="flex items-center justify-between border-b border-line px-5 py-3.5">
          <h2 className="flex items-center gap-2 font-display text-base font-semibold text-navy">
            <History className="h-4 w-4 text-primary" aria-hidden="true" />
            <span>{L('Nhật ký vụ án', 'Case Log')}{auditOnlyCase && caseName ? ` · ${caseName}` : ''}</span>
          </h2>
          <div className="flex items-center gap-2">
            {caseName && (
              <button
                type="button"
                onClick={() => setAuditOnlyCase(!auditOnlyCase)}
                className="rounded border border-line px-2 py-1 text-xs text-ink hover:bg-hover cursor-pointer"
              >
                {auditOnlyCase ? L('Vụ này', 'This case') : L('Tất cả', 'All cases')}
              </button>
            )}
            <button
              type="button"
              onClick={loadAudit}
              disabled={auditBusy}
              title={L('Làm mới', 'Refresh')}
              className="rounded border border-line p-1.5 text-ink hover:bg-hover cursor-pointer disabled:opacity-50"
            >
              <RefreshCw className={`h-3.5 w-3.5 ${auditBusy ? 'animate-spin' : ''}`} />
            </button>
            <button type="button" onClick={() => auditDlg.current?.close()} aria-label={L('Đóng', 'Close')} className={CLOSE}><X className="h-4 w-4" /></button>
          </div>
        </div>
        <div className="max-h-[65vh] overflow-y-auto p-4">
          {(() => {
            const list = auditOnlyCase && caseName
              ? auditItems.filter(a => !a.target || a.target === caseName || a.target.startsWith(`${caseName}/`) || a.target.includes(caseName))
              : auditItems
            if (auditBusy && !list.length) return <p className="py-8 text-center text-sm text-muted">{L('Đang tải nhật ký…', 'Loading log…')}</p>
            if (!list.length) return <p className="py-8 text-center text-sm text-muted">{L('Chưa có nhật ký hoạt động nào.', 'No activity recorded yet.')}</p>
            const actLabel = (a: string) => (isVi ? ({
              'case.create': 'Tạo vụ án',
              'case.rename': 'Đổi tên vụ án',
              'case.delete': 'Xoá vụ án',
              'device.create': 'Thêm thiết bị',
              'device.delete': 'Xoá thiết bị',
              'device.rename': 'Đổi tên thiết bị',
              'device.image': 'Đóng image',
              'device.extract': 'Trích xuất',
              'pull.start': 'Thu thập ADB',
              'package.create': 'Đóng gói chứng cứ',
              'sync.queue': 'Đồng bộ',
              'phone.connect': 'Cắm thiết bị',
              'phone.disconnect': 'Rút thiết bị',
              'file.delete': 'Xoá tệp',
            }[a] ?? a) : a)
            return (
              <ul className="divide-y divide-line text-xs">
                {list.map(a => (
                  <li key={a.id} className="flex items-start justify-between gap-3 py-2.5">
                    <div className="min-w-0 flex-1">
                      <div className="flex items-center gap-2">
                        <span className="rounded bg-primary-soft px-1.5 py-0.5 font-mono text-[10.5px] font-semibold text-primary">
                          {actLabel(a.action)}
                        </span>
                        {a.target && <span className="truncate font-medium text-ink">{a.target}</span>}
                      </div>
                      {a.detail && <p className="mt-0.5 truncate text-[11px] text-muted">{a.detail}</p>}
                    </div>
                    <span className="shrink-0 font-mono tabular-nums text-[11px] text-muted">{formatDateTime(a.created_at)}</span>
                  </li>
                ))}
              </ul>
            )
          })()}
        </div>
      </dialog>
      {toast && (
        <div role="status" className="fixed bottom-5 right-5 z-50 flex items-center gap-2 rounded-xl border border-[#00b8ff]/50 bg-[#061836]/95 px-4 py-2.5 text-sm font-medium text-white shadow-[0_0_24px_rgba(0,184,255,0.4)] backdrop-blur-md">
          <CheckCircle2 className="h-4 w-4 shrink-0 text-[#38c8ff]" aria-hidden="true" />
          <span>{toast}</span>
        </div>
      )}
    </div>
  )
}
