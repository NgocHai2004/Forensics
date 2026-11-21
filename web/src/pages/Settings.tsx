import { useEffect, useState } from 'react'
import type { FormEvent } from 'react'
import { ScrollText, UserPlus } from 'lucide-react'
import { api, ApiError } from '../api'
import type { AuditEntry, User } from '../api'

const INPUT = 'h-10 w-full rounded-lg border border-line bg-card px-3 text-sm text-ink placeholder:text-muted'
const LABEL = 'mb-1 block text-sm font-medium text-ink'
const ddmmyyyy = (iso: string) => `${iso.slice(8, 10)}/${iso.slice(5, 7)}/${iso.slice(0, 4)}`

export default function Settings() {
  const [users, setUsers] = useState<User[] | null>(null)
  const [username, setUsername] = useState('')
  const [pass, setPass] = useState('')
  const [pass2, setPass2] = useState('')
  const [err, setErr] = useState('')
  const [ok, setOk] = useState('')
  const [busy, setBusy] = useState(false)
  const load = () => api.users().then(setUsers).catch((e: Error) => setErr(e.message))
  useEffect(() => { load() }, [])
  const [audit, setAudit] = useState<AuditEntry[] | null>(null)
  useEffect(() => { api.audit(100).then(setAudit).catch(() => setAudit([])) }, [])

  const submit = async (e: FormEvent) => {
    e.preventDefault(); setErr(''); setOk('')
    if (!username.trim()) return setErr('Nhập tên đăng nhập')
    if (pass.length < 8) return setErr('Mật khẩu tối thiểu 8 ký tự')
    if (pass !== pass2) return setErr('Mật khẩu nhập lại không khớp')
    setBusy(true)
    try {
      const u = await api.createUser(username.trim(), pass)
      setOk(`Đã tạo tài khoản ${u.username}`); setUsername(''); setPass(''); setPass2(''); load()
    } catch (x) { setErr(x instanceof ApiError ? x.message : 'Không gọi được máy chủ') } finally { setBusy(false) }
  }

  return (
    <section className="card p-5">
      <h2 className="mb-3 flex items-center gap-2 font-display text-base font-semibold text-navy"><UserPlus className="h-4 w-4" aria-hidden="true" /> Đăng ký tài khoản</h2>
      {users?.length === 0 && (
        <p className="mb-3 rounded-lg bg-warning/10 p-3 text-sm text-ink">
          Chưa có tài khoản nào nên hiện nhập tên, mật khẩu bất kỳ đều đăng nhập được. Sau khi tạo tài khoản đầu tiên, chỉ tài khoản đã đăng ký mới đăng nhập được.
        </p>
      )}
      <form onSubmit={submit} noValidate className="flex flex-col gap-3">
        <div>
          <label htmlFor="u-name" className={LABEL}>Tên đăng nhập</label>
          <input id="u-name" value={username} onChange={e => setUsername(e.target.value)} maxLength={32} autoComplete="off"
            placeholder="vd: dtv.nam (chữ không dấu, số, . _ -)" aria-invalid={!!err} aria-describedby={err ? 'u-err' : undefined} className={INPUT} />
        </div>
        <div>
          <label htmlFor="u-pass" className={LABEL}>Mật khẩu</label>
          <input id="u-pass" type="password" value={pass} onChange={e => setPass(e.target.value)} maxLength={128} autoComplete="new-password" placeholder="Tối thiểu 8 ký tự" className={INPUT} />
        </div>
        <div>
          <label htmlFor="u-pass2" className={LABEL}>Nhập lại mật khẩu</label>
          <input id="u-pass2" type="password" value={pass2} onChange={e => setPass2(e.target.value)} maxLength={128} autoComplete="new-password" className={INPUT} />
        </div>
        {err && <p id="u-err" role="alert" className="text-sm text-danger">{err}</p>}
        {ok && <p role="status" className="text-sm text-success">{ok}</p>}
        <button type="submit" disabled={busy}
          className="inline-flex h-10 items-center gap-2 self-start rounded-lg bg-primary px-4 text-sm font-medium text-white transition-colors duration-150 hover:bg-primary-hover disabled:opacity-50">
          <UserPlus className="h-4 w-4" aria-hidden="true" /> {busy ? 'Đang tạo…' : 'Tạo tài khoản'}
        </button>
      </form>
      {!!users?.length && (
        <>
          <h3 className="mb-2 mt-5 text-xs font-semibold uppercase tracking-wide text-muted">Tài khoản đã đăng ký ({users.length})</h3>
          <ul className="divide-y divide-line text-sm">
            {users.map(u => (
              <li key={u.username} className="flex items-center justify-between py-2">
                <span className="truncate text-ink">{u.username}</span>
                <span className="shrink-0 text-xs text-muted">Tạo {ddmmyyyy(u.created_at)}</span>
              </li>
            ))}
          </ul>
        </>
      )}
      <h2 className="mb-3 mt-6 flex items-center gap-2 font-display text-base font-semibold text-navy"><ScrollText className="h-4 w-4" aria-hidden="true" /> Lịch sử hoạt động</h2>
      <p className="mb-3 flex flex-wrap gap-2">
        <a href="/api/export/audit" download className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-ink transition-colors hover:bg-hover"><ScrollText className="h-3.5 w-3.5" aria-hidden="true" /> Xuất nhật ký CSV</a>
        <a href="/api/export/devices" download className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-ink transition-colors hover:bg-hover">Xuất danh sách thiết bị CSV</a>
        <a href="/api/export/images" download className="inline-flex min-h-8 items-center gap-1.5 rounded-lg border border-line bg-card px-3 text-xs font-medium text-ink transition-colors hover:bg-hover">Xuất danh sách image CSV</a>
      </p>
      {audit === null && <div className="h-24 animate-pulse" aria-busy="true" aria-label="Đang tải" />}
      {audit && audit.length === 0 && <p className="text-sm text-muted">Chưa có hoạt động nào.</p>}
      {audit && audit.length > 0 && (
        <ul className="divide-y divide-line text-sm">
          {audit.map(a => (
            <li key={a.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1.5">
              <span className="shrink-0 text-xs text-muted">{ddmmyyyy(a.created_at) + ' ' + a.created_at.slice(11, 19)}</span>
              <span className="shrink-0 font-mono text-xs text-navy">{a.action}</span>
              {a.target && <span className="truncate text-ink">{a.target}</span>}
              {a.detail && <span className="w-full truncate text-xs text-muted" title={a.detail}>{a.detail}</span>}
            </li>
          ))}
        </ul>
      )}
    </section>
  )
}
