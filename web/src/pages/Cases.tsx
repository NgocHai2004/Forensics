import { Fragment, useEffect, useRef, useState } from 'react'
import type { ComponentType } from 'react'
import { Link } from 'react-router-dom'
import { Briefcase, Cctv, ChevronRight, File, FileText, HardDrive, Image, Laptop, Layers, Music, Package, Plus, SearchX, Smartphone, Video, X } from 'lucide-react'
import { api, ApiError, fmtSize, KIND_LABEL } from '../api'
import type { Case, Device, DeviceType, FileItem, Kind } from '../api'
import Empty from '../components/Empty'

const INPUT = 'h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted'
const BTN = 'inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50'
const BTN2 = 'inline-flex h-10 items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-medium text-ink transition-colors duration-150 hover:bg-hover'
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`
type Icon = ComponentType<{ className?: string }>
const DEVICE: Record<DeviceType, { label: string; icon: Icon }> = {
  laptop: { label: 'Laptop / PC', icon: Laptop }, hdd: { label: 'Ổ cứng', icon: HardDrive }, phone: { label: 'Điện thoại', icon: Smartphone },
  camera: { label: 'Đầu thu camera', icon: Cctv }, video: { label: 'Video / Audio', icon: Video }, other: { label: 'Thiết bị khác', icon: Package },
}
const KIND_ICON: Record<Kind, Icon> = { image: Image, video: Video, audio: Music, document: FileText, other: File }

// Cây chi tiết 1 vụ án: thiết bị -> kiểu -> tài liệu (mở/gập), tải theo tên vụ.
function CaseExpand({ name }: { name: string }) {
  const [data, setData] = useState<{ devs: Device[]; files: FileItem[] } | null>(null)
  const [err, setErr] = useState('')
  const [open, setOpen] = useState<Record<string, boolean>>({})
  const toggle = (k: string) => setOpen(o => ({ ...o, [k]: !o[k] }))
  useEffect(() => {
    let live = true
    Promise.all([api.devices(name), api.files({ collection: name, limit: 200 })])
      .then(([d, f]) => { if (live) setData({ devs: d.items, files: f.items }) })
      .catch((e: Error) => live && setErr(e.message))
    return () => { live = false }
  }, [name])
  if (err) return <p role="alert" className="text-danger">{err}</p>
  if (!data) return <div className="flex h-16 items-center justify-center text-sm text-muted">Đang tải…</div>
  const byDev: Record<string, FileItem[]> = {}
  for (const f of data.files) (byDev[f.device ?? ''] ??= []).push(f)
  const byKind = (dev: string) => {
    const m: Record<string, FileItem[]> = {}
    for (const f of byDev[dev] ?? []) (m[f.kind] ??= []).push(f)
    return m
  }
  const kinds = Object.keys(KIND_LABEL) as Kind[]
  if (data.files.length === 0 && data.devs.length === 0)
    return <p className="text-sm text-muted">Vụ án chưa có thiết bị hoặc tài liệu.</p>
  return (
    <div className="divide-y divide-line/60 text-sm">
      {data.devs.map(d => {
        const devFiles = byDev[d.name] ?? []
        const k = 'dev:' + d.name
        const openDev = open[k] ?? false
        const DevIcon = DEVICE[d.type].icon
        const dk = byKind(d.name)
        return (
          <div key={d.name}>
            <button type="button" onClick={() => toggle(k)} className="flex w-full items-center gap-2 px-1 py-2 text-left transition-colors hover:bg-hover">
              <ChevronRight className={`h-4 w-4 shrink-0 text-muted transition-transform ${openDev ? 'rotate-90' : ''}`} aria-hidden="true" />
              <DevIcon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
              <span className="min-w-0 flex-1 truncate font-medium text-navy">{d.name}</span>
              <span className="shrink-0 text-xs text-muted">{DEVICE[d.type].label} · {devFiles.length} tài liệu</span>
            </button>
            {openDev && (
              <div className="ml-4 border-l border-line pl-4">
                {kinds.filter(kd => (dk[kd] ?? []).length > 0).map(kd => {
                  const filesOfKind = dk[kd]
                  const Ki = KIND_ICON[kd]
                  const k2 = 'kind:' + d.name + ':' + kd
                  const openK = open[k2] ?? true
                  return (
                    <div key={kd}>
                      <button type="button" onClick={() => toggle(k2)} className="flex w-full items-center gap-2 px-1 py-1.5 text-left transition-colors hover:bg-hover">
                        <ChevronRight className={`h-3.5 w-3.5 shrink-0 text-muted transition-transform ${openK ? 'rotate-90' : ''}`} aria-hidden="true" />
                        <Ki className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
                        <span className="min-w-0 flex-1 truncate text-ink">{KIND_LABEL[kd]}</span>
                        <span className="shrink-0 text-xs text-muted">{filesOfKind.length}</span>
                      </button>
                      {openK && (
                        <ul className="ml-4 border-l border-line">
                          {filesOfKind.map(f => (
                            <li key={f.id}>
                              <a href={f.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-1 py-1.5 text-ink transition-colors hover:bg-hover hover:text-primary">
                                {f.thumb_url ? <img src={f.thumb_url} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded object-cover" /> : <Ki className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                                <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                                <span className="shrink-0 text-xs text-muted">{fmtSize(f.size)}</span>
                              </a>
                            </li>
                          ))}
                        </ul>
                      )}
                    </div>
                  )
                })}
              </div>
            )}
          </div>
        )
      })}
      {(byDev[''] ?? []).length > 0 && (
        <div>
          <button type="button" onClick={() => toggle('dev:unassigned')} className="flex w-full items-center gap-2 px-1 py-2 text-left transition-colors hover:bg-hover">
            <ChevronRight className={`h-4 w-4 shrink-0 text-muted transition-transform ${open['dev:unassigned'] ? 'rotate-90' : ''}`} aria-hidden="true" />
            <Layers className="h-4 w-4 shrink-0 text-muted" aria-hidden="true" />
            <span className="min-w-0 flex-1 truncate font-medium text-ink">Chưa gán thiết bị</span>
            <span className="shrink-0 text-xs text-muted">{(byDev[''] ?? []).length} tài liệu</span>
          </button>
          {open['dev:unassigned'] && (
            <div className="ml-4 border-l border-line pl-4">
              {byDev[''].map(f => {
                const Ki = KIND_ICON[f.kind]
                return (
                  <a key={f.id} href={f.file_url} target="_blank" rel="noreferrer" className="flex items-center gap-2 px-2 py-1.5 text-ink transition-colors hover:bg-hover">
                    {f.thumb_url ? <img src={f.thumb_url} alt="" loading="lazy" className="h-6 w-6 shrink-0 rounded object-cover" /> : <Ki className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />}
                    <span className="min-w-0 flex-1 truncate" title={f.name}>{f.name}</span>
                    <span className="shrink-0 text-xs text-muted">{fmtSize(f.size)}</span>
                  </a>
                )
              })}
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default function Cases() {
  const [cases, setCases] = useState<Case[] | null>(null)
  const [loadErr, setLoadErr] = useState('')
  const [search, setSearch] = useState('')
  const [from, setFrom] = useState('')  // 'YYYY-MM-DD' từ <input type=date>, rỗng = không lọc
  const [to, setTo] = useState('')
  const [name, setName] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const dlg = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)

  useEffect(() => { api.cases().then(setCases).catch((e: Error) => setLoadErr(e.message)) }, [])

  // lọc không phân biệt hoa thường/dấu
  const fold = (x: string) => x.normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase()
  const q = fold(search.trim())
  const shown = (cases ?? []).filter(c => (!q || fold(c.name).includes(q))
    && (!from || c.created_at.slice(0, 10) >= from) && (!to || c.created_at.slice(0, 10) <= to))
  const filtering = !!(q || from || to)
  const [openCase, setOpenCase] = useState<string | null>(null)

  // hộp thoại tạo vụ án: <dialog> gốc lo khoá focus, Esc để đóng; điền sẵn tên đang tìm
  const openCreate = () => { setName(search.trim()); setNote(''); setErr(''); dlg.current?.showModal(); nameRef.current?.focus() }
  const closeCreate = () => dlg.current?.close()

  const create = async (e: React.FormEvent) => {
    e.preventDefault()
    setErr('')
    if (!name.trim()) return setErr('Nhập tên vụ án')
    setBusy(true)
    try {
      const c = await api.createCase(name.trim(), note.trim())
      setCases(cur => [c, ...(cur ?? [])])
      setSearch(''); closeCreate()
    } catch (ex) {
      setErr(ex instanceof ApiError ? ex.message : 'Không gọi được máy chủ')
    } finally { setBusy(false) }
  }

  return (
    <div>
      <section role="search" aria-label="Lọc vụ án" className="card mb-4 flex flex-wrap items-center gap-x-4 gap-y-2 px-5 py-3">
        <div className="flex min-w-64 flex-1 items-center gap-2">
          <label htmlFor="case-search" className="shrink-0 text-sm font-medium text-ink">Tìm vụ án</label>
          <input id="case-search" type="search" value={search} onChange={e => setSearch(e.target.value)} placeholder="Gõ tên để lọc" className={INPUT} />
        </div>
        <div className="flex items-center gap-2">
          <label htmlFor="case-from" className="shrink-0 text-sm font-medium text-ink">Ngày tạo</label>
          <input id="case-from" type="date" value={from} max={to || undefined} onChange={e => setFrom(e.target.value)} aria-label="Từ ngày" className={`${INPUT} w-auto`} />
          <span className="text-muted" aria-hidden="true">–</span>
          <input id="case-to" type="date" value={to} min={from || undefined} onChange={e => setTo(e.target.value)} aria-label="Đến ngày" className={`${INPUT} w-auto`} />
          {(from || to) && (
            <button type="button" onClick={() => { setFrom(''); setTo('') }} aria-label="Bỏ lọc ngày"
              className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"><X className="h-4 w-4" /></button>
          )}
        </div>
        <button type="button" onClick={openCreate} className={BTN}><Plus className="h-4 w-4" aria-hidden="true" /> Tạo vụ án</button>
      </section>

      <dialog ref={dlg} aria-labelledby="new-case-title" onClick={e => { if (e.target === e.currentTarget) closeCreate() }}
        className="m-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-ink shadow-xl backdrop:bg-navy/40">
        <form onSubmit={create} noValidate className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id="new-case-title" className="font-display text-base font-semibold text-navy">Tạo vụ án mới</h2>
            <button type="button" onClick={closeCreate} aria-label="Đóng"
              className="flex h-10 w-10 items-center justify-center rounded-lg text-muted transition-colors hover:bg-hover hover:text-ink"><X className="h-4 w-4" /></button>
          </div>
          <div>
            <label htmlFor="case-name" className="mb-1 block text-sm font-medium text-ink">Tên vụ án</label>
            <input ref={nameRef} id="case-name" value={name} onChange={e => setName(e.target.value)} maxLength={60} placeholder="vd: vu-an-01"
              aria-invalid={!!err} aria-describedby={err ? 'case-err' : undefined} className={INPUT} />
          </div>
          <div>
            <label htmlFor="case-note" className="mb-1 block text-sm font-medium text-ink">Ghi chú <span className="font-normal text-muted">(tuỳ chọn)</span></label>
            <textarea id="case-note" value={note} onChange={e => setNote(e.target.value)} maxLength={200} rows={3}
              className="w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink placeholder:text-muted" />
          </div>
          {err && <p id="case-err" role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={closeCreate} className={BTN2}>Huỷ</button>
            <button type="submit" disabled={busy} className={BTN}><Plus className="h-4 w-4" aria-hidden="true" /> {busy ? 'Đang tạo…' : 'Tạo vụ án'}</button>
          </div>
        </form>
      </dialog>

      <section aria-labelledby="case-list-title" className="rounded-xl border border-line bg-white/60 p-4 lg:min-h-[calc(100vh-56px-2rem-82px)]">
        <h2 id="case-list-title" className="mb-3 flex items-center gap-2 font-display text-sm font-semibold text-navy">
          <Briefcase className="h-4 w-4 text-primary" aria-hidden="true" /> Danh sách vụ án
          {cases && <span aria-live="polite" className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-navy">{filtering ? `${shown.length}/${cases.length}` : cases.length}</span>}
        </h2>
        {loadErr && <p className="text-danger">Không tải được danh sách: {loadErr}</p>}
        {!loadErr && !cases && (
          <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-3" aria-busy="true" aria-label="Đang tải">
            {[0, 1, 2].map(i => <div key={i} className="card h-40 animate-pulse" />)}
          </div>
        )}
        {cases && cases.length === 0 && <Empty icon={Briefcase} title="Chưa có vụ án" desc="Tạo vụ án đầu tiên ở trên để bắt đầu." />}
        {cases && cases.length > 0 && shown.length === 0 && (
          <Empty icon={SearchX} title="Không có vụ án khớp" desc={q ? `Bấm "Tạo vụ án" để tạo vụ án "${search.trim()}".` : 'Thử đổi khoảng ngày.'} />
        )}
        {shown.length > 0 && (
          <div className="flex items-start gap-4">
            {/* Bảng dữ liệu các vụ án (phong cách Magnet) */}
            <div className="min-w-0 flex-1 overflow-hidden rounded-xl border border-line bg-white">
              <table className="w-full text-sm">
                <thead>
                  <tr className="border-b border-line bg-primary-soft text-left text-xs font-semibold uppercase tracking-wide text-navy">
                    <th className="px-4 py-2.5">Tên vụ án</th>
                    <th className="px-3 py-2.5 text-right">Thiết bị</th>
                    <th className="px-3 py-2.5 text-right">Tài liệu</th>
                    <th className="px-4 py-2.5 text-right">Ngày tạo</th>
                    <th className="w-40 px-2 py-2.5 text-right">Chi tiết</th>
                  </tr>
                </thead>
                <tbody>
                  {shown.map(c => {
                    const open = openCase === c.name
                    return (
                    <Fragment key={c.name}>
                    <tr className="border-b border-line/60 transition-colors hover:bg-hover">
                      <td className="px-4 py-3">
                        <Link to={`/cases/${encodeURIComponent(c.name)}`} className="font-semibold text-navy hover:text-primary transition-colors hover:underline">
                          {c.name}
                        </Link>
                        {c.note && <span className="ml-2 text-xs text-muted">{c.note}</span>}
                      </td>
                      <td className="px-3 py-3 text-right text-ink">{c.device_count}</td>
                      <td className="px-3 py-3 text-right text-ink">{c.count}</td>
                      <td className="px-4 py-3 text-right text-muted">{ddmmyyyy(c.created_at)}</td>
                      <td className="px-2 py-3 text-right">
                        <div className="flex items-center justify-end gap-1.5">
                          <Link to={`/cases/${encodeURIComponent(c.name)}`}
                            className="inline-flex min-h-8 items-center gap-1 rounded-lg bg-[#00a89d] text-white px-2.5 py-1 text-xs font-medium hover:bg-[#009288] transition-colors shadow-2xs">
                            Mở AXIOM
                          </Link>
                          <button type="button" onClick={() => setOpenCase(openCase === c.name ? null : c.name)}
                            className={`inline-flex min-h-8 items-center gap-1 rounded-lg border border-line bg-card px-2.5 py-1 text-xs font-medium text-ink transition-colors hover:bg-hover ${openCase === c.name ? 'border-primary bg-primary-soft! text-navy' : ''}`}>
                            {openCase === c.name ? 'Thu gọn' : 'Cây file'} <ChevronRight className={`h-3.5 w-3.5 transition-transform ${openCase === c.name ? 'rotate-90' : ''}`} aria-hidden="true" />
                          </button>
                        </div>
                      </td>
                    </tr>
                    {open && (
                      <tr className="border-b border-line/60 bg-canvas/40">
                        <td colSpan={5} className="px-4 py-3"><CaseExpand name={c.name} /></td>
                      </tr>
                    )}
                    </Fragment>
                  )})}
                </tbody>
              </table>
            </div>

          </div>
        )}
      </section>
    </div>
  )
}
