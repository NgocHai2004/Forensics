import { useEffect, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ArrowLeft, Briefcase, File, History, Plus, Trash2, FileText, Film, Image, Music, Send, Sparkles, Upload, X } from 'lucide-react'
import type { ComponentType } from 'react'
import { api, ApiError, locUrl } from '../api'
import type { Case, ChatMsg, FileItem, IndexStatus, Kind, Source } from '../api'
import Empty from '../components/Empty'
import { KIND_LABEL } from '../api'

type Msg = ChatMsg & { sources?: Source[] }
interface Conv { messages: Msg[]; sources: Source[]; error: string | null }

const EMPTY: Conv = { messages: [], sources: [], error: null }
// Lịch sử hỏi đáp: { tên vụ án: cuộc trò chuyện[] } trong localStorage của trình duyệt này
interface Saved { id: string; title: string; at: string; messages: Msg[]; sources: Source[] }
const STORE = 'mf_chat_history', MAX_CHATS = 50
const loadHist = (): Record<string, Saved[]> => { try { return JSON.parse(localStorage.getItem(STORE) ?? '{}') } catch { return {} } }
const when = (iso: string) => new Date(iso).toLocaleString('vi-VN', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' })
const kindIcon: Record<Kind, ComponentType<{ className?: string }>> = { image: Image, video: Film, audio: Music, document: FileText, other: File }
const KINDS = Object.keys(KIND_LABEL) as Kind[]
const CHIPS = ['Tóm tắt các file có chữ', 'Liệt kê file theo thời gian']
// Cùng bảng ext -> kind với docs/02-contract-web-v1.md, chỉ để gắn nhãn file vừa chọn trước khi tải lên.
const EXT_KIND: Record<string, Kind> = Object.fromEntries(Object.entries({
  image: 'jpg jpeg png gif webp bmp tif tiff heic heif', video: 'mp4 mov mkv avi webm 3gp m4v',
  audio: 'mp3 m4a wav aac ogg opus amr flac', document: 'txt md csv json log pdf doc docx xls xlsx ppt pptx',
}).flatMap(([k, s]) => s.split(' ').map(e => [e, k as Kind])))
const kindOf = (name: string): Kind => EXT_KIND[name.split('.').pop()?.toLowerCase() ?? ''] ?? 'other'
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Không kết nối được máy chủ.')

const label = (s: Source) => (s.loc ? `${s.name} · ${s.loc}` : s.name)

function Thumb({ s }: { s: Source }) {
  const Icon = kindIcon[s.kind]
  return (
    <a href={locUrl(s.file_url, s.loc)} target="_blank" rel="noreferrer" title={label(s)} aria-label={`Mở file ${label(s)}`}
      className="block h-16 w-16 shrink-0 overflow-hidden rounded-lg border border-line bg-canvas transition hover:border-primary">
      {s.thumb_url
        ? <img src={s.thumb_url} alt="" className="h-full w-full object-cover" />
        : <span className="flex h-full flex-col items-center justify-center gap-1 text-[10px] font-semibold text-muted">
            <Icon className="h-5 w-5" />{(s.name.split('.').pop() ?? '').toUpperCase().slice(0, 5)}
          </span>}
    </a>
  )
}

function Answer({ m }: { m: Msg }) {
  // split với 2 nhóm bắt: [văn bản, id, loc|undefined, văn bản, ...]
  const parts = m.content.split(/\[#(\d+)(?:\s*@\s*([^\]]+))?\]/)
  return (
    <p className="whitespace-pre-wrap text-sm leading-relaxed">
      {parts.map((p, i) => {
        // văn bản: in đậm các đoạn **...** mà model hay trả về
        if (i % 3 === 0) return p.split('**').map((t, j) => (j % 2 ? <strong key={j}>{t}</strong> : t))
        if (i % 3 === 2) return null
        const loc = parts[i + 1]?.trim()
        const s = m.sources?.find(x => x.id === Number(p))
        const tag = loc ? `#${p} · ${loc}` : `#${p}`
        return s
          ? <a key={i} href={locUrl(s.file_url, loc || s.loc)} target="_blank" rel="noreferrer" aria-label={`Mở file ${s.name}${loc ? ` tại ${loc}` : ''}`}
              className="mx-0.5 inline-block rounded bg-primary-soft px-1.5 text-xs font-semibold text-primary transition hover:bg-primary hover:text-white">{tag}</a>
          : `[${tag}]`
      })}
    </p>
  )
}

function FileRow({ name, kind, href }: { name: string; kind: Kind; href?: string }) {
  const Icon = kindIcon[kind]
  const inner = <><Icon className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" /><span className="truncate">{name}</span></>
  return href
    ? <a href={href} target="_blank" rel="noreferrer" className="flex min-h-10 items-center gap-2 rounded-lg px-2 py-1.5 text-sm transition hover:bg-hover">{inner}</a>
    : <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">{inner}</span>
}

export default function Chat() {
  const [sp, setSp] = useSearchParams()
  const sel = sp.get('case') ?? ''
  // vụ án khác hỏi cùng: giữ trên URL (?with=...) để tải lại trang không mất
  const extra = sp.getAll('with').filter(n => n && n !== sel)
  // <option> không cắt chữ bằng CSS được: cắt sẵn để danh sách xổ xuống không rộng quá cột Chi tiết
  const short = (n: string) => (n.length > 24 ? n.slice(0, 23).trimEnd() + '…' : n)
  const setExtra = (xs: string[]) => setSp(xs.length ? { case: sel, with: xs } : { case: sel }, { replace: true })
  const [cases, setCases] = useState<Case[]>([])
  const [hist, setHist] = useState<Record<string, Saved[]>>(loadHist)
  const [active, setActive] = useState('')  // id cuộc trò chuyện đang mở; '' = cuộc mới chưa hỏi gì
  const [errs, setErrs] = useState<Record<string, string | null>>({})
  const [input, setInput] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const [drawer, setDrawer] = useState(false)
  const [upOpen, setUpOpen] = useState(false)
  const [files, setFiles] = useState<File[]>([])
  const [drag, setDrag] = useState(false)
  const [upErr, setUpErr] = useState('')
  const [busy, setBusy] = useState(false)
  const [run, setRun] = useState<IndexStatus | null>(null)
  const [docs, setDocs] = useState<FileItem[]>([])
  const ta = useRef<HTMLTextAreaElement>(null)
  const end = useRef<HTMLDivElement>(null)
  const detailBtn = useRef<HTMLButtonElement>(null)
  const closeDrawer = () => { setDrawer(false); detailBtn.current?.focus() }  // trả focus về nút mở, không rơi xuống body

  const cur = cases.find(c => c.name === sel) ?? null
  const chats = [...(hist[sel] ?? [])].sort((a, b) => b.at.localeCompare(a.at))
  const chat = chats.find(c => c.id === active)
  const conv: Conv = { ...(chat ?? EMPTY), error: errs[active] ?? null }
  const running = run?.status === 'running'
  const patch = (name: string, id: string, fn: (c: Saved) => Saved) =>
    setHist(h => ({ ...h, [name]: (h[name] ?? []).map(c => (c.id === id ? { ...fn(c), at: new Date().toISOString() } : c)) }))
  const newChat = () => { setActive(''); setInput(''); ta.current?.focus() }
  const removeChat = (id: string) => { setHist(h => ({ ...h, [sel]: (h[sel] ?? []).filter(c => c.id !== id) })); if (id === active) setActive('') }
  useEffect(() => { try { localStorage.setItem(STORE, JSON.stringify(hist)) } catch { /* đầy bộ nhớ / chế độ ẩn danh: chỉ mất lịch sử */ } }, [hist])
  useEffect(() => { setActive('') }, [sel])
  const loadCases = () => api.cases().then(setCases).catch(() => {})
  const loadDocs = (name: string) => (name ? api.files({ collection: name, limit: 50 }).then(p => setDocs(p.items)).catch(() => setDocs([])) : setDocs([]))
  const track = (s: IndexStatus) => { setRun(s); if (s.status !== 'running') { loadCases(); loadDocs(sel) } }

  useEffect(() => { loadCases(); api.indexStatus().then(s => setRun(r => r ?? s)).catch(() => {}) }, [])
  useEffect(() => { loadDocs(sel) }, [sel])
  useEffect(() => {
    if (!running) return
    const t = setInterval(() => api.indexStatus().then(track).catch(() => {}), 2000)
    return () => clearInterval(t)
  }, [running, sel])
  useEffect(() => { const el = ta.current; if (el) { el.style.height = 'auto'; el.style.height = `${el.scrollHeight}px` } }, [input])
  useEffect(() => { end.current?.scrollIntoView({ block: 'end' }) }, [conv.messages.length, conv.error, pending])

  const send = async () => {
    const q = input.trim(); const name = sel
    if (!q || pending || !name) return
    const history = conv.messages.map(({ role, content }) => ({ role, content }))
    let id = active
    if (!chat) {  // câu hỏi đầu tiên: tạo cuộc trò chuyện mới, tiêu đề = câu hỏi
      id = Date.now().toString(36)
      setHist(h => ({ ...h, [name]: [{ id, title: q.slice(0, 80), at: new Date().toISOString(), messages: [], sources: [] }, ...(h[name] ?? [])].slice(0, MAX_CHATS) }))
      setActive(id)
    }
    setErrs(e => ({ ...e, [id]: null }))
    patch(name, id, c => ({ ...c, messages: [...c.messages, { role: 'user', content: q }] }))
    setInput(''); setPending(id)
    try {
      const r = await api.ask(q, history, name, extra)
      patch(name, id, c => ({ ...c, sources: r.sources, messages: [...c.messages, { role: 'assistant', content: r.answer, sources: r.sources }] }))
    } catch (e) {
      const msg = e instanceof ApiError
        ? e.status === 400 && e.message.includes('chưa có tài liệu') ? `${e.message}. Thêm tài liệu hoặc thêm vụ án khác ở cột Chi tiết.` : `Lỗi ${e.status}: ${e.message}`
        : 'Không kết nối được máy chủ.'
      setErrs(es => ({ ...es, [id]: msg }))
    } finally { setPending(null) }
  }

  const addFiles = (list: FileList | null) => {
    // Chụp lại ngay: FileList là "live", onChange xóa input.value sau lời gọi này nên đọc trễ trong updater sẽ ra rỗng.
    const picked = Array.from(list ?? [])
    if (!picked.length) return
    setUpErr('')
    setFiles(cur => [...cur, ...picked.filter(f => !cur.some(c => c.name === f.name && c.size === f.size))])
  }
  const upload = async () => {
    if (!files.length || !sel) return
    setBusy(true); setUpErr('')
    try {
      await api.upload(files, sel)
      setFiles([]); setUpOpen(false); loadCases()
      track(await api.indexStatus())
    } catch (ex) { setUpErr(errMsg(ex)) } finally { setBusy(false) }
  }

  const chips = (
    <div className="flex flex-wrap gap-2">
      {CHIPS.map(t => (
        <button key={t} type="button" onClick={() => { setInput(t); ta.current?.focus() }}
          className="rounded-full border border-line bg-card px-3 py-2 text-sm text-ink transition hover:border-primary hover:bg-primary-soft">{t}</button>
      ))}
    </div>
  )

  const r = run && run.status !== 'idle' ? run : null
  const pct = r && r.total ? Math.round((r.done / r.total) * 100) : 0

  const detail = (
    <>
      <h2 className="font-display font-semibold text-navy">Chi tiết</h2>
      {!cur ? <p className="mt-1 text-sm text-muted">Chưa chọn vụ án.</p> : (
        <>
          <p className="mt-2 truncate font-display text-base font-semibold text-navy" title={cur.name}>{cur.name}</p>
          {cur.note && <p className="text-xs text-muted">{cur.note}</p>}
          <div className="mt-2 flex flex-wrap gap-1">
            {cur.count
              ? KINDS.filter(k => cur.by_kind[k]).map(k => <span key={k} className="rounded-full bg-primary-soft px-2 py-0.5 text-xs font-medium text-navy">{KIND_LABEL[k]} {cur.by_kind[k]}</span>)
              : <span className="text-xs text-muted">Chưa có tài liệu</span>}
          </div>

          <button type="button" onClick={() => setUpOpen(o => !o)} aria-expanded={upOpen}
            className="mt-3 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg border border-primary px-3 text-sm font-semibold text-primary transition hover:bg-primary-soft">
            <Upload className="h-4 w-4" aria-hidden="true" />Thêm tài liệu
          </button>
          {upOpen && (
            <div className="mt-2">
              <label onDragOver={e => { e.preventDefault(); setDrag(true) }} onDragLeave={() => setDrag(false)}
                onDrop={e => { e.preventDefault(); setDrag(false); addFiles(e.dataTransfer.files) }}
                className={`flex cursor-pointer flex-col items-center gap-1 rounded-lg border-2 border-dashed p-4 text-center text-xs text-muted transition ${drag ? 'border-primary bg-primary-soft' : 'border-line hover:border-primary'}`}>
                <input type="file" multiple className="sr-only" onChange={e => { addFiles(e.target.files); e.target.value = '' }} />
                <Upload className="h-5 w-5 text-primary" aria-hidden="true" />Kéo thả hoặc bấm để chọn file
              </label>
              {files.length > 0 && (
                <ul className="mt-2 space-y-1">
                  {files.map((f, i) => (
                    <li key={f.name + f.size} className="flex items-center gap-1 rounded-lg bg-canvas px-2 py-1">
                      <FileRow name={f.name} kind={kindOf(f.name)} />
                      <span className="shrink-0 rounded-full bg-primary-soft px-1.5 text-[10px] font-medium text-navy">{KIND_LABEL[kindOf(f.name)]}</span>
                      <button type="button" aria-label={`Bỏ ${f.name}`} onClick={() => setFiles(fs => fs.filter((_, j) => j !== i))}
                        className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted transition hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                    </li>
                  ))}
                </ul>
              )}
              {upErr && <p role="alert" className="mt-1 text-xs text-danger">{upErr}</p>}
              <button type="button" onClick={() => void upload()} disabled={busy || !files.length}
                className="mt-2 flex min-h-10 w-full items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50">
                <Upload className="h-4 w-4" aria-hidden="true" />{busy ? 'Đang tải...' : `Tải lên${files.length ? ` (${files.length})` : ''}`}
              </button>
            </div>
          )}
          {r && (
            <div className="mt-3">
              <div className="flex items-center justify-between text-xs text-muted">
                <span>{r.status === 'running' ? 'Đang index...' : r.status === 'error' ? 'Lỗi index' : 'Index xong'}</span><span>{r.done}/{r.total}</span>
              </div>
              <div className="mt-1 h-2 overflow-hidden rounded-full bg-primary-soft" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100} aria-label="Tiến trình index">
                <div className="h-full rounded-full bg-primary transition-all duration-200" style={{ width: `${pct}%` }} />
              </div>
              {r.message && <p className={`mt-1 text-xs ${r.status === 'error' ? 'text-danger' : 'text-muted'}`}>{r.message}</p>}
            </div>
          )}

          <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Tài liệu ({docs.length})</p>
          {docs.length
            ? <ul className="mt-1">{docs.map(f => <li key={f.id}><FileRow name={f.name} kind={f.kind} href={f.file_url} /></li>)}</ul>
            : <p className="mt-1 text-sm text-muted">Chưa có tài liệu.</p>}

          <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Hỏi thêm từ vụ án khác ({extra.length})</p>
          {extra.length > 0 && (
            <ul className="mt-1 space-y-1">
              {extra.map(n => (
                <li key={n} className="flex items-center gap-1 rounded-lg bg-canvas px-2 py-1">
                  <Briefcase className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
                  <span className="min-w-0 flex-1 truncate text-sm" title={n}>{n}</span>
                  <span className="shrink-0 text-xs text-muted">{cases.find(c => c.name === n)?.count ?? 0} file</span>
                  <button type="button" aria-label={`Bỏ vụ án ${n}`} onClick={() => setExtra(extra.filter(x => x !== n))}
                    className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted transition hover:text-danger"><X className="h-3.5 w-3.5" /></button>
                </li>
              ))}
            </ul>
          )}
          {cases.some(c => c.name !== sel && !extra.includes(c.name)) ? (
            <select aria-label="Thêm vụ án khác để hỏi cùng" value="" onChange={e => { if (e.target.value) setExtra([...extra, e.target.value]) }}
              className="mt-2 min-h-10 w-full rounded-lg border border-line bg-card px-2 text-sm text-ink">
              <option value="">+ Thêm vụ án…</option>
              {cases.filter(c => c.name !== sel && !extra.includes(c.name)).map(c => <option key={c.name} value={c.name} title={`${c.name} (${c.count} file)`}>{short(c.name)} ({c.count})</option>)}
            </select>
          ) : !extra.length && <p className="mt-1 text-sm text-muted">Không còn vụ án khác.</p>}

          <p className="mt-5 text-xs font-semibold uppercase tracking-wide text-muted">File liên quan</p>
          {conv.sources.length
            ? <ul className="mt-1">{conv.sources.map(s => <li key={s.id}><FileRow name={label(s)} kind={s.kind} href={locUrl(s.file_url, s.loc)} /></li>)}</ul>
            : <p className="mt-1 text-sm text-muted">Chưa có file liên quan.</p>}
        </>
      )}
    </>
  )

  return (
    // Nền ảnh phủ toàn vùng main (bù padding p-6 của Shell); các khung chat giữ nền trắng để đọc được.
    <div className="-m-6 flex h-[calc(100vh-56px)] gap-4 bg-navy bg-cover bg-center p-6"
      style={{ backgroundImage: 'url(/chat-bg.png)' }}>
      <aside className="card hidden w-60 shrink-0 flex-col bg-white/80! md:flex" aria-label="Lịch sử hỏi đáp">
        <h2 className="mx-3 mt-3 flex items-center gap-2 font-display font-semibold text-navy"><History className="h-4 w-4 text-primary" aria-hidden="true" />Lịch sử</h2>
        <button type="button" onClick={newChat} disabled={!sel}
          className="m-3 flex min-h-10 items-center justify-center gap-2 rounded-lg bg-primary px-3 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:opacity-50">
          <Plus className="h-4 w-4" aria-hidden="true" />Cuộc trò chuyện mới
        </button>
        <ul className="flex-1 space-y-0.5 overflow-y-auto px-2 pb-2">
          {chats.length === 0 && <li className="px-3 py-2 text-sm text-muted">Chưa có cuộc trò chuyện nào.</li>}
          {chats.map(c => (
            <li key={c.id} className="group flex items-center gap-1">
              <button type="button" onClick={() => setActive(c.id)} aria-current={c.id === active || undefined}
                className={`flex min-w-0 flex-1 flex-col rounded-lg px-3 py-2 text-left transition hover:bg-hover ${c.id === active ? 'bg-primary-soft' : ''}`}>
                <span className={`truncate text-sm ${c.id === active ? 'font-semibold text-navy' : 'text-ink'}`} title={c.title}>{c.title}</span>
                <span className="text-xs text-muted">{when(c.at)} · {c.messages.filter(m => m.role === 'user').length} câu hỏi</span>
              </button>
              <button type="button" onClick={() => removeChat(c.id)} aria-label={`Xoá cuộc trò chuyện ${c.title}`} title="Xoá"
                className="flex h-8 w-8 shrink-0 items-center justify-center rounded text-muted opacity-0 transition group-hover:opacity-100 hover:text-danger focus-visible:opacity-100">
                <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            </li>
          ))}
        </ul>
      </aside>
      <section className="flex min-w-0 flex-1 flex-col gap-3">
        <header className="card flex items-center gap-2 bg-white/85! px-4 py-2">
          {sel && <Link to={'/cases/' + encodeURIComponent(sel)} aria-label={`Về vụ án ${sel}`} title="Về vụ án"
            className="flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition hover:bg-hover hover:text-navy"><ArrowLeft className="h-4 w-4" /></Link>}
          <h1 className="flex min-w-0 flex-1 items-center gap-2 font-display text-base font-semibold text-navy">
            <Sparkles className="h-4 w-4 shrink-0 text-primary" aria-hidden="true" />
            <span className="truncate" title={sel}>{sel ? `Hỏi đáp: ${sel}${extra.length ? ` + ${extra.length} vụ án` : ''}` : 'Hỏi đáp'}</span>
          </h1>
          <button ref={detailBtn} type="button" onClick={() => setDrawer(d => !d)} aria-expanded={drawer} aria-controls="chat-detail"
            className="min-h-10 rounded-lg border border-line px-3 text-sm font-medium text-navy transition hover:bg-hover xl:hidden">Chi tiết</button>
        </header>

        <div className="flex-1 space-y-5 overflow-y-auto px-2 py-2">
          {!sel && (
            <div className="card mx-auto mt-8 max-w-lg bg-white/85! px-6">
              <Empty icon={Briefcase} title="Chưa chọn vụ án" desc="Hỏi đáp AI chỉ trả lời trong phạm vi một vụ án. Mở vụ án ở trang Vụ án rồi bấm Hỏi đáp."
                action={<Link to="/cases" className="text-sm font-medium text-primary hover:underline">Đi tới danh sách vụ án</Link>} />
            </div>
          )}
          {sel && conv.messages.length === 0 && (
            <div className="card mx-auto mt-8 max-w-lg bg-white/85! px-6">
              <Empty icon={Sparkles} title="Cyber AI sẵn sàng" desc={`Hỏi về nội dung, thời gian, vị trí của các tài liệu trong vụ án "${sel}".`} action={chips} />
            </div>
          )}
          {conv.messages.map((m, i) => m.role === 'user'
            ? <div key={i} className="flex justify-end gap-2">
                <div className="max-w-[75%] rounded-2xl rounded-tr-sm bg-ai-soft px-4 py-2.5 text-sm text-ink whitespace-pre-wrap">{m.content}</div>
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-navy text-[10px] font-semibold text-white" aria-hidden="true">ĐTV</span>
              </div>
            : <div key={i} className="flex gap-2">
                <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Sparkles className="h-4 w-4" aria-hidden="true" /></span>
                <div className="min-w-0 max-w-[80%]">
                  <p className="mb-1 text-xs font-semibold text-white drop-shadow">Cyber AI</p>
                  <div className="rounded-2xl rounded-tl-sm bg-canvas px-4 py-2.5"><Answer m={m} /></div>
                  {!!m.sources?.length && <div className="mt-2 flex gap-2 overflow-x-auto pb-1">{m.sources.map(s => <Thumb key={s.id} s={s} />)}</div>}
                  {i === conv.messages.length - 1 && <div className="mt-3">{chips}</div>}
                </div>
              </div>)}
          {conv.error && (
            <div className="flex gap-2">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Sparkles className="h-4 w-4" aria-hidden="true" /></span>
              <div className="rounded-2xl rounded-tl-sm border border-danger/30 bg-canvas px-4 py-2.5 text-sm text-danger" role="alert">{conv.error}</div>
            </div>
          )}
          {pending && pending === active && (
            <div className="flex items-center gap-2 text-sm text-white drop-shadow" aria-live="polite">
              <span className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full bg-primary-soft text-primary"><Sparkles className="h-4 w-4" aria-hidden="true" /></span>
              <span className="flex gap-1" aria-hidden="true">
                {[0, 150, 300].map(d => <span key={d} className="h-2 w-2 animate-bounce rounded-full bg-primary motion-reduce:animate-none" style={{ animationDelay: `${d}ms` }} />)}
              </span>
              đang trả lời...
            </div>
          )}
          <div ref={end} />
        </div>

        <form onSubmit={e => { e.preventDefault(); void send() }} className="card flex items-end gap-2 bg-white/85! p-3">
          <label htmlFor="ask" className="sr-only">Câu hỏi</label>
          <textarea id="ask" ref={ta} rows={1} value={input} onChange={e => setInput(e.target.value)} disabled={!sel}
            onKeyDown={e => { if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) { e.preventDefault(); void send() } }}
            placeholder={sel ? 'Hỏi AI về tài liệu của vụ án...' : 'Chọn vụ án trước khi hỏi'}
            className="max-h-32 min-h-10 flex-1 resize-none overflow-y-auto rounded-lg border border-line bg-card px-3 py-2 text-sm focus:border-primary disabled:cursor-not-allowed disabled:opacity-60" />
          <button type="submit" disabled={!sel || !!pending || !input.trim()}
            className="flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-semibold text-white transition hover:bg-primary-hover disabled:cursor-not-allowed disabled:opacity-50">
            <Send className="h-4 w-4" aria-hidden="true" />Gửi
          </button>
        </form>
      </section>

      <aside className="card hidden w-[260px] shrink-0 overflow-y-auto bg-white/80! p-4 xl:block">{detail}</aside>

      {drawer && (
        <div className="fixed inset-0 z-40 xl:hidden">
          <button type="button" aria-label="Đóng chi tiết" onClick={closeDrawer} className="absolute inset-0 bg-navy/30" />
          <aside id="chat-detail" className="absolute top-0 right-0 flex h-full w-[280px] max-w-full flex-col overflow-y-auto bg-card p-4 shadow-card" onKeyDown={e => { if (e.key === 'Escape') closeDrawer() }}>
            <button type="button" autoFocus onClick={closeDrawer} className="mb-2 min-h-10 self-end rounded-lg border border-line px-3 text-sm text-navy transition hover:bg-hover">Đóng</button>
            {detail}
          </aside>
        </div>
      )}
    </div>
  )
}
