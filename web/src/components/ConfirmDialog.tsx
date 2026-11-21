import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { Trash2, TriangleAlert } from 'lucide-react'

/** Hộp thoại xác nhận giữa màn hình (thay window.confirm). open=true thì hiện; Esc / bấm nền / Huỷ = onCancel. */
export default function ConfirmDialog({ open, title, children, confirmLabel = 'Xoá', busy = false, onConfirm, onCancel }: {
  open: boolean; title: string; children: ReactNode; confirmLabel?: string; busy?: boolean
  onConfirm: () => void; onCancel: () => void
}) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelBtn = useRef<HTMLButtonElement>(null)
  const id = useId()
  useEffect(() => {
    const d = ref.current
    if (!d) return
    if (open && !d.open) { d.showModal(); cancelBtn.current?.focus() }  // mặc định focus Huỷ: lỡ Enter cũng không xoá
    if (!open && d.open) d.close()
  }, [open])
  return (
    <dialog ref={ref} aria-labelledby={`${id}-t`} aria-describedby={`${id}-d`}
      onCancel={e => { e.preventDefault(); if (!busy) onCancel() }}
      onClick={e => { if (e.target === e.currentTarget && !busy) onCancel() }}
      className="m-auto w-[min(26rem,calc(100vw-2rem))] rounded-xl bg-card p-0 text-ink shadow-xl backdrop:bg-navy/40">
      <div className="flex flex-col gap-4 p-5">
        <div className="flex items-start gap-3">
          <span className="flex h-10 w-10 shrink-0 items-center justify-center rounded-full bg-danger/10 text-danger"><TriangleAlert className="h-5 w-5" aria-hidden="true" /></span>
          <div className="min-w-0">
            <h2 id={`${id}-t`} className="font-display text-base font-semibold text-navy">{title}</h2>
            <div id={`${id}-d`} className="mt-1 text-sm text-muted">{children}</div>
          </div>
        </div>
        <div className="flex justify-end gap-2">
          <button ref={cancelBtn} type="button" onClick={onCancel} disabled={busy}
            className="inline-flex min-h-10 items-center rounded-lg border border-line bg-card px-4 text-sm font-medium text-ink transition-colors duration-150 hover:bg-hover disabled:opacity-50">Huỷ</button>
          <button type="button" onClick={onConfirm} disabled={busy}
            className="inline-flex min-h-10 items-center gap-2 rounded-lg bg-danger px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-danger/90 disabled:opacity-50">
            <Trash2 className="h-4 w-4" aria-hidden="true" />{busy ? 'Đang xoá…' : confirmLabel}
          </button>
        </div>
      </div>
    </dialog>
  )
}
