import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { Files, HardDrive, Sparkles, AlertTriangle } from 'lucide-react'
import { api, fmtSize } from '../api'
import type { Stats, FileItem } from '../api'
import { TrendArea, KindDonut, KIND_LABEL } from '../components/charts'
import Empty from '../components/Empty'
import DeviceStatus from '../components/DeviceStatus'

const hhmm = (iso: string) => iso.slice(11, 16)

export default function Dashboard() {
  const [stats, setStats] = useState<Stats | null>(null)
  const [recent, setRecent] = useState<FileItem[]>([])
  const [err, setErr] = useState('')
  const [mode, setMode] = useState<'day' | 'month'>('day')

  useEffect(() => {
    Promise.all([api.stats(), api.files({ limit: 5 })])
      .then(([s, f]) => { setStats(s); setRecent(f.items) })
      .catch((e: Error) => setErr(e.message))
  }, [])

  if (err) return <div><p className="text-danger">Không tải được dữ liệu: {err}</p></div>
  if (!stats) return (
    <div>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4" aria-busy="true" aria-label="Đang tải">
        {[0, 1, 2, 3].map(i => <div key={i} className="card h-24 animate-pulse" />)}
      </div>
      <div className="mt-4 grid gap-4 lg:grid-cols-2"><div className="card h-80 animate-pulse" /><div className="card h-80 animate-pulse" /></div>
    </div>
  )

  const cards = [
    { label: 'Tổng file', value: String(stats.total), icon: Files },
    { label: 'Dung lượng', value: fmtSize(stats.total_size), icon: HardDrive },
    { label: 'Đã mô tả', value: String(stats.captioned), icon: Sparkles },
    { label: 'Lỗi', value: String(stats.errors), icon: AlertTriangle },
  ]
  return (
    <div className="flex flex-col gap-4 lg:min-h-[calc(100vh-56px-2rem)]">
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {cards.map(c => (
          <div key={c.label} className="card card-hover flex items-center gap-4 p-5">
            <span className="flex h-11 w-11 items-center justify-center rounded-lg bg-primary-soft text-primary"><c.icon className="h-5 w-5" aria-hidden="true" /></span>
            <div><p className="text-sm text-muted">{c.label}</p><p className="font-display text-2xl font-semibold text-navy">{c.value}</p></div>
          </div>
        ))}
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-2">
        <section className="card card-hover flex flex-col p-5">
          <div className="mb-3 flex items-center justify-between gap-2">
            <h2 className="font-display text-base font-semibold text-navy">Tiến trình thu thập</h2>
            <div className="flex rounded-lg border border-line p-0.5 text-sm" role="group" aria-label="Khoảng thời gian">
              {([['day', '7 ngày'], ['month', 'Theo tháng']] as const).map(([m, label]) => (
                <button key={m} type="button" aria-pressed={mode === m} onClick={() => setMode(m)}
                  className={`min-h-8 rounded-md px-3 transition-colors duration-150 ${mode === m ? 'bg-primary text-white' : 'text-muted hover:text-ink'}`}>{label}</button>
              ))}
            </div>
          </div>
          <TrendArea data={mode === 'day' ? stats.by_day : stats.by_month} mode={mode} />
        </section>
        <section className="card card-hover flex flex-col p-5">
          <h2 className="mb-3 font-display text-base font-semibold text-navy">Trạng thái thiết bị</h2>
          <DeviceStatus />
        </section>
      </div>

      <div className="grid flex-1 gap-4 lg:grid-cols-2">
        <section className="card card-hover flex flex-col p-5">
          <h2 className="mb-3 font-display text-base font-semibold text-navy">Phân loại dữ liệu</h2>
          <KindDonut data={stats.by_kind} />
        </section>
        <section className="card card-hover flex flex-col p-5">
          <h2 className="mb-3 font-display text-base font-semibold text-navy">Hoạt động gần đây</h2>
          {recent.length ? (
            <ul className="flex flex-1 flex-col divide-y divide-line text-base">
              {recent.map(f => (
                <li key={f.id} className="flex flex-1">
                  <Link to="/evidence" className="flex min-h-11 flex-1 items-center gap-2 px-1 transition-colors duration-150 hover:bg-hover">
                    <span className="w-14 shrink-0 font-mono text-muted">{hhmm(f.mtime)}</span>
                    <span className="truncate text-ink">{f.name}</span>
                    <span className="ml-auto shrink-0 rounded bg-primary-soft px-2 py-0.5 text-sm text-navy">{KIND_LABEL[f.kind]}</span>
                  </Link>
                </li>
              ))}
            </ul>
          ) : <Empty icon={Files} title="Chưa có hoạt động" desc="Chưa có file nào được index." />}
        </section>
      </div>
    </div>
  )
}
