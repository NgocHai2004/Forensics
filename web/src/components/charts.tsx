import { ResponsiveContainer, AreaChart, Area, XAxis, YAxis, Tooltip, PieChart, Pie, Cell } from 'recharts'
import type { Kind } from '../api'
import { KIND_LABEL } from '../api'
export { KIND_LABEL }

// Màu theo kind cố định: teal đậm -> xanh dương -> xám, mỗi bậc cách nhau đủ xa để phân biệt (kể cả mù màu); legend luôn kèm số.
export const KIND_COLOR: Record<Kind, string> = { image: '#14919b', video: '#0b5c63', audio: '#6cc8cf', document: '#3b6fb6', other: '#9aa5b1' }
const KINDS: Kind[] = ['image', 'video', 'audio', 'document', 'other']
const mmyy = (m: string) => `${m.slice(5, 7)}/${m.slice(2, 4)}`
export const TIP = { borderRadius: 8, borderColor: '#e5e7eb', fontSize: 13 }

const ddmm = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`

/** mode 'day': by_day ('YYYY-MM-DD'), 'month': by_month ('YYYY-MM'). */
export function TrendArea({ data, mode }: { data: { day?: string; month?: string; count: number }[]; mode: 'day' | 'month' }) {
  const unit = mode === 'day' ? 'Ngày' : 'Tháng'
  const rows = data.map(d => ({ month: mode === 'day' ? ddmm(d.day ?? '') : mmyy(d.month ?? ''), count: d.count }))
  return (
    <div className="relative min-h-64 flex-1" role="img" aria-label={`Số file theo ${unit.toLowerCase()}: ${rows.map(r => `${r.month}: ${r.count}`).join(', ') || 'chưa có dữ liệu'}`}>
      <div className="absolute inset-0"><ResponsiveContainer width="100%" height="100%">
        <AreaChart data={rows} margin={{ top: 8, right: 8, left: -16, bottom: 0 }}>
          <XAxis dataKey="month" tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={{ stroke: '#e5e7eb' }} tickLine={false} />
          <YAxis allowDecimals={false} tick={{ fontSize: 12, fill: '#6b7280' }} axisLine={false} tickLine={false} />
          <Tooltip formatter={(v) => [v, 'Số file']} labelFormatter={(l) => `${unit} ${l}`} contentStyle={TIP} />
          <Area type="monotone" dataKey="count" stroke="#14919b" strokeWidth={2} fill="#14919b" fillOpacity={0.15} dot={{ r: 4, fill: '#14919b', stroke: '#fff', strokeWidth: 2 }} activeDot={{ r: 6 }} />
        </AreaChart>
      </ResponsiveContainer></div>
    </div>
  )
}

export function KindDonut({ data }: { data: Partial<Record<Kind, number>> }) {
  const rows = KINDS.map(k => ({ kind: k, name: KIND_LABEL[k], value: data[k] ?? 0 })).filter(r => r.value > 0)
  const total = rows.reduce((s, r) => s + r.value, 0)
  return (
    <div className="flex flex-1 flex-col items-center gap-4 sm:flex-row" role="img" aria-label={`Phân loại ${total} file: ${rows.map(r => `${r.name} ${r.value}`).join(', ') || 'chưa có dữ liệu'}`}>
      <div className="relative h-64 w-full sm:h-full sm:min-h-64 sm:w-1/2">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={rows} dataKey="value" nameKey="name" innerRadius="62%" outerRadius="90%" paddingAngle={2} stroke="#fff" strokeWidth={2} isAnimationActive={false}>
              {rows.map(r => <Cell key={r.kind} fill={KIND_COLOR[r.kind]} />)}
            </Pie>
            <Tooltip formatter={(v, n) => [`${v} file`, n]} contentStyle={TIP} />
          </PieChart>
        </ResponsiveContainer>
        <div className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
          <span className="font-display text-3xl font-semibold text-navy">{total}</span>
          <span className="text-sm text-muted">file</span>
        </div>
      </div>
      <ul className="flex w-full flex-col justify-around gap-2 self-stretch text-base sm:w-1/2">
        {KINDS.map(k => (
          <li key={k} className="flex items-center gap-2">
            <span className="h-4 w-4 shrink-0 rounded-sm" style={{ background: KIND_COLOR[k] }} aria-hidden="true" />
            <span className="flex-1 text-ink">{KIND_LABEL[k]}</span>
            <span className="font-display text-lg font-semibold text-ink">{data[k] ?? 0}</span>
            <span className="w-12 text-right text-muted">{total ? Math.round(((data[k] ?? 0) / total) * 100) : 0}%</span>
          </li>
        ))}
      </ul>
    </div>
  )
}
