import { useEffect, useId, useRef, useState } from 'react'
import type { FormEvent, MouseEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { Info, Pencil, Save, Trash2, TriangleAlert, X } from 'lucide-react'
import { api, ApiError } from '../api'
import type { Case } from '../api'

const FIELD = 'h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted'
const BTN = 'inline-flex min-h-10 items-center gap-2 rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50'
const BTN2 = 'inline-flex min-h-10 cursor-pointer items-center gap-2 rounded-lg border border-line bg-card px-4 text-sm font-medium text-ink transition-colors duration-150 hover:bg-hover'
const DLG = 'm-auto w-[min(28rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-ink shadow-xl backdrop:bg-navy/40'
const CLOSE = 'flex h-10 w-10 shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150 hover:bg-hover hover:text-ink'
const errMsg = (e: unknown) => (e instanceof ApiError ? e.message : 'Không gọi được máy chủ')

/** Nút icon Sửa / Xoá vụ án + 2 hộp thoại. Có onDone (trang danh sách): báo Case mới / null khi xoá, không chuyển trang. */
export default function CaseActions({ name, initial, onDone, small = false }:
  { name: string; initial?: Case; onDone?: (c: Case | null) => void; small?: boolean }) {
  const navigate = useNavigate()
  const id = useId()  // nhiều thẻ vụ án trên một trang: id của ô nhập không được trùng
  const [info, setInfo] = useState<Case | null>(initial ?? null)
  const [newName, setNewName] = useState('')
  const [note, setNote] = useState('')
  const [confirm, setConfirm] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const editDlg = useRef<HTMLDialogElement>(null)
  const delDlg = useRef<HTMLDialogElement>(null)
  const nameRef = useRef<HTMLInputElement>(null)
  const confirmRef = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (initial) { setInfo(initial); return }
    api.cases().then(cs => setInfo(cs.find(c => c.name === name) ?? null)).catch(() => {})
  }, [name, initial])

  const openEdit = () => { setNewName(name); setNote(info?.note ?? ''); setErr(''); editDlg.current?.showModal(); nameRef.current?.select() }
  const openDel = () => { setConfirm(''); setErr(''); delDlg.current?.showModal(); confirmRef.current?.focus() }
  const save = async (e: FormEvent) => {
    e.preventDefault(); setErr('')
    if (!newName.trim()) return setErr('Nhập tên vụ án')
    setBusy(true)
    try {
      const c = await api.updateCase(name, newName.trim(), note.trim())
      setInfo(c); editDlg.current?.close()
      if (onDone) onDone(c)
      else if (c.name !== name) navigate('/cases/' + encodeURIComponent(c.name), { replace: true })
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const remove = async (e: FormEvent) => {
    e.preventDefault(); setErr('')
    setBusy(true)
    try {
      await api.deleteCase(name); delDlg.current?.close()
      if (onDone) onDone(null)
      else navigate('/cases', { replace: true })
    } catch (x) { setErr(errMsg(x)) } finally { setBusy(false) }
  }
  const closeOnBackdrop = (e: MouseEvent<HTMLDialogElement>) => { if (e.target === e.currentTarget) e.currentTarget.close() }
  const icon = `flex ${small ? 'h-8 w-8' : 'h-10 w-10'} shrink-0 items-center justify-center rounded-lg text-muted transition-colors duration-150`

  return (
    <>
      <button type="button" onClick={openEdit} title="Sửa vụ án" aria-label={`Sửa vụ án ${name}`} className={`${icon} hover:bg-hover hover:text-navy`}>
        <Pencil className="h-4 w-4" aria-hidden="true" />
      </button>
      <button type="button" onClick={openDel} title="Xoá vụ án" aria-label={`Xoá vụ án ${name}`} className={`${icon} hover:bg-danger/10 hover:text-danger`}>
        <Trash2 className="h-4 w-4" aria-hidden="true" />
      </button>

      <dialog ref={editDlg} aria-labelledby={`${id}-et`} onClick={closeOnBackdrop} className={DLG}>
        <form onSubmit={save} noValidate className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id={`${id}-et`} className="flex items-center gap-2 font-display text-base font-semibold text-navy"><Pencil className="h-4 w-4 text-primary" aria-hidden="true" /> Sửa vụ án</h2>
            <button type="button" onClick={() => editDlg.current?.close()} aria-label="Đóng" className={CLOSE}><X className="h-4 w-4" /></button>
          </div>
          <div>
            <label htmlFor={`${id}-en`} className="mb-1 block text-sm font-medium text-ink">Tên vụ án</label>
            <input ref={nameRef} id={`${id}-en`} value={newName} onChange={e => setNewName(e.target.value)} maxLength={60}
              aria-invalid={!!err} aria-describedby={err ? `${id}-ee` : undefined} className={FIELD} />
          </div>
          <div>
            <label htmlFor={`${id}-eo`} className="mb-1 block text-sm font-medium text-ink">Ghi chú <span className="font-normal text-muted">(tuỳ chọn)</span></label>
            <textarea id={`${id}-eo`} value={note} onChange={e => setNote(e.target.value)} maxLength={500} rows={3}
              className="w-full resize-none rounded-lg border border-line bg-card px-3 py-2 text-sm text-ink" />
          </div>
          {err && <p id={`${id}-ee`} role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => editDlg.current?.close()} className={BTN2}>Huỷ</button>
            <button type="submit" disabled={busy} className={BTN}><Save className="h-4 w-4" aria-hidden="true" /> {busy ? 'Đang lưu…' : 'Lưu'}</button>
          </div>
        </form>
      </dialog>

      <dialog ref={delDlg} aria-labelledby={`${id}-dt`} onClick={closeOnBackdrop} className={DLG}>
        <form onSubmit={remove} noValidate className="flex flex-col gap-4 p-5">
          <div className="flex items-center justify-between gap-2">
            <h2 id={`${id}-dt`} className="flex items-center gap-2 font-display text-base font-semibold text-danger"><TriangleAlert className="h-4 w-4" aria-hidden="true" /> Xoá vụ án</h2>
            <button type="button" onClick={() => delDlg.current?.close()} aria-label="Đóng" className={CLOSE}><X className="h-4 w-4" /></button>
          </div>
          <div className="space-y-2 text-sm text-ink">
            <p>Xoá <strong>{name}</strong> cùng <strong>{info?.count ?? 0} tài liệu</strong>, thiết bị, mô tả AI và sơ đồ quan hệ của vụ án. Không hoàn tác được.</p>
            <p className="flex items-start gap-2 rounded-lg bg-canvas p-2 text-xs text-muted"><Info className="mt-0.5 h-3.5 w-3.5 shrink-0" aria-hidden="true" />
              File đã tải lên được chuyển vào thư mục <code>data/trash</code> trên máy chủ; dữ liệu gốc trong <code>/evidence</code> không bị đụng tới.</p>
          </div>
          <div>
            <label htmlFor={`${id}-dc`} className="mb-1 block text-sm font-medium text-ink">Gõ lại tên vụ án để xác nhận</label>
            <input ref={confirmRef} id={`${id}-dc`} value={confirm} onChange={e => setConfirm(e.target.value)} placeholder={name} autoComplete="off"
              aria-invalid={!!err} aria-describedby={err ? `${id}-de` : undefined} className={FIELD} />
          </div>
          {err && <p id={`${id}-de`} role="alert" className="text-sm text-danger">{err}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => delDlg.current?.close()} className={BTN2}>Huỷ</button>
            <button type="submit" disabled={busy || confirm.trim() !== name}
              className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-danger/90 disabled:opacity-50">
              <Trash2 className="h-4 w-4" aria-hidden="true" /> {busy ? 'Đang xoá…' : 'Xoá vụ án'}
            </button>
          </div>
        </form>
      </dialog>
    </>
  )
}
