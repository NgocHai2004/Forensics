import { useEffect, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { Search, X, ExternalLink, Image, Video, Music, FileText, File, FolderOpen } from 'lucide-react'
import type { ComponentType } from 'react'
import { api, fmtSize } from '../api'
import type { Kind, FileItem, FilesPage } from '../api'
import { KIND_LABEL } from '../api'
import Empty from '../components/Empty'

const LIMIT = 48
const ICON: Record<Kind, ComponentType<{ className?: string }>> = { image: Image, video: Video, audio: Music, document: FileText, other: File }
const CHIPS: { kind?: Kind; label: string }[] = [{ label: 'Tất cả' }, ...(Object.keys(KIND_LABEL) as Kind[]).map(k => ({ kind: k, label: KIND_LABEL[k] }))]

function Tile({ f, onClick, selected }: { f: FileItem; onClick: () => void; selected: boolean }) {
  const Icon = ICON[f.kind]
  return (
    <button id={`tile-${f.id}`} type="button" onClick={onClick} aria-pressed={selected} title={f.name}
      className={`card flex min-h-[140px] flex-col overflow-hidden text-left transition-shadow duration-150 hover:shadow-md ${selected ? 'ring-2 ring-primary' : ''}`}>
      {f.thumb_url ? <img src={f.thumb_url} alt="" className="h-24 w-full object-cover" loading="lazy" /> : (
        <div className="flex h-24 w-full flex-col items-center justify-center gap-1 bg-canvas text-muted">
          <Icon className="h-6 w-6" aria-hidden="true" /><span className="text-xs font-semibold">{f.ext.replace('.', '').toUpperCase()}</span>
        </div>
      )}
      <span className="truncate px-2 py-2 text-xs text-ink">{f.name}</span>
    </button>
  )
}

function Field({ k, v }: { k: string; v: string | number | null }) {
  return v === null || v === '' ? null : <div><dt className="text-xs text-muted">{k}</dt><dd className="break-words text-sm text-ink">{v}</dd></div>
}

function Detail({ f, onClose }: { f: FileItem; onClose: () => void }) {
  let tags: string[] = []
  try { tags = f.tags ? (JSON.parse(f.tags) as string[]) : [] } catch { tags = [] }
  return (
    <aside className="card h-fit p-4 lg:sticky lg:top-6" aria-label="Chi tiết file">
      <div className="mb-3 flex items-start justify-between gap-2">
        <h2 className="break-all font-display text-base font-semibold text-navy">{f.name}</h2>
        <button type="button" onClick={onClose} aria-label="Đóng chi tiết" className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover"><X className="h-4 w-4" /></button>
      </div>
      {f.thumb_url && <img src={f.thumb_url} alt={f.caption ?? f.name} className="mb-3 w-full rounded-lg object-contain" />}
      {f.collection && <span className="mb-3 inline-block rounded bg-primary-soft px-2 py-0.5 text-xs text-navy">Vụ án: {f.collection}</span>}
      <dl className="space-y-2">
        <Field k="Loại" v={KIND_LABEL[f.kind]} />
        <Field k="Dung lượng" v={fmtSize(f.size)} />
        <Field k="Sửa đổi" v={f.mtime.replace('T', ' ')} />
        <Field k="Chụp lúc" v={f.taken_at} />
        <Field k="Tọa độ" v={f.lat !== null && f.lon !== null ? `${f.lat}, ${f.lon}` : null} />
        <Field k="Mô tả" v={f.caption} />
        <Field k="OCR" v={f.ocr_text} />
        {tags.length > 0 && <div><dt className="text-xs text-muted">Thẻ</dt><dd className="mt-1 flex flex-wrap gap-1">{tags.map(t => <span key={t} className="rounded bg-primary-soft px-2 py-0.5 text-xs text-navy">{t}</span>)}</dd></div>}
        {f.text_content && <div><dt className="text-xs text-muted">Nội dung</dt><dd><pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded bg-canvas p-2 text-xs text-ink">{f.text_content.slice(0, 2000)}</pre></dd></div>}
        {f.error && <div><dt className="text-xs text-muted">Lỗi</dt><dd className="text-sm text-danger">{f.error}</dd></div>}
      </dl>
      <a href={f.file_url} target="_blank" rel="noopener noreferrer" className="mt-4 inline-flex h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-hover">
        <ExternalLink className="h-4 w-4" aria-hidden="true" /> Mở file gốc
      </a>
    </aside>
  )
}

export default function Evidence() {
  const [sp] = useSearchParams()
  const [kind, setKind] = useState<Kind | undefined>()
  const [collection, setCollection] = useState(sp.get('case') ?? '')
  const [cols, setCols] = useState<string[]>([])
  const [input, setInput] = useState('')
  const [q, setQ] = useState('')
  const [page, setPage] = useState(1)
  const [data, setData] = useState<FilesPage | null>(null)
  const [sel, setSel] = useState<FileItem | null>(null)
  const [err, setErr] = useState('')

  useEffect(() => { api.collections().then(c => setCols(c.map(x => x.collection))).catch(() => {}) }, [])
  useEffect(() => {
    let live = true
    setData(null); setErr('')
    api.files({ kind, q, page, limit: LIMIT, collection }).then(d => live && setData(d)).catch((e: Error) => live && setErr(e.message))
    return () => { live = false }
  }, [kind, q, page, collection])

  const pages = data ? Math.max(1, Math.ceil(data.total / LIMIT)) : 1
  return (
    <div>
      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-2" role="group" aria-label="Lọc theo loại">
          {CHIPS.map(c => (
            <button key={c.label} type="button" aria-pressed={kind === c.kind} onClick={() => { setKind(c.kind); setPage(1); setSel(null) }}
              className={`h-10 rounded-full border px-4 text-sm transition-colors duration-150 ${kind === c.kind ? 'border-primary bg-primary-soft font-semibold text-navy' : 'border-line bg-card text-ink hover:bg-hover'}`}>
              {c.label}
            </button>
          ))}
        </div>
        <label htmlFor="ev-col" className="sr-only">Vụ án</label>
        <select id="ev-col" value={collection} onChange={e => { setCollection(e.target.value); setPage(1); setSel(null) }}
          className="h-10 rounded-lg border border-line bg-card px-3 text-sm text-ink">
          <option value="">Tất cả vụ án</option>
          {cols.map(c => <option key={c} value={c}>{c}</option>)}
        </select>
        <form className="ml-auto flex items-center gap-2" onSubmit={e => { e.preventDefault(); setQ(input.trim()); setPage(1); setSel(null) }}>
          <label htmlFor="ev-q" className="sr-only">Tìm kiếm</label>
          <input id="ev-q" type="search" value={input} onChange={e => setInput(e.target.value)} placeholder="Tìm tên, mô tả, OCR..."
            className="h-10 w-56 rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted" />
          <button type="submit" aria-label="Tìm kiếm" className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary text-white transition-colors duration-150 hover:bg-primary-hover"><Search className="h-4 w-4" /></button>
        </form>
      </div>

      {err && <p className="text-danger">Không tải được danh sách: {err}</p>}
      {!err && !data && (
        <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3" aria-busy="true" aria-label="Đang tải">
          {Array.from({ length: 12 }, (_, i) => <div key={i} className="card h-[140px] animate-pulse" />)}
        </div>
      )}
      {data && data.items.length === 0 && <Empty icon={FolderOpen} title="Không có file" desc={q || kind || collection ? 'Thử đổi bộ lọc hoặc từ khóa.' : 'Chưa có file nào được index.'} />}
      {data && data.items.length > 0 && (
        <div className={`grid gap-4 ${sel ? 'lg:grid-cols-[1fr_320px]' : ''}`}>
          <div>
            <div className="grid grid-cols-[repeat(auto-fill,minmax(140px,1fr))] gap-3">
              {data.items.map(f => <Tile key={f.id} f={f} selected={sel?.id === f.id} onClick={() => setSel(f)} />)}
            </div>
            <nav className="mt-4 flex items-center justify-center gap-3 text-sm" aria-label="Phân trang">
              <button type="button" disabled={page <= 1} onClick={() => setPage(p => p - 1)} className="h-10 rounded-lg border border-line bg-card px-4 text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50">Trước</button>
              <span className="text-muted">Trang {page}/{pages}</span>
              <button type="button" disabled={page >= pages} onClick={() => setPage(p => p + 1)} className="h-10 rounded-lg border border-line bg-card px-4 text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50">Sau</button>
            </nav>
          </div>
          {sel && <Detail f={sel} onClose={() => { document.getElementById(`tile-${sel.id}`)?.focus(); setSel(null) }} />}
        </div>
      )}
    </div>
  )
}
