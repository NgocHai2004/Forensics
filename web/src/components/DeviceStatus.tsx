import { useEffect, useState } from 'react'
import { ResponsiveContainer, LineChart, Line, XAxis, YAxis, Tooltip, RadialBarChart, RadialBar, PolarAngleAxis } from 'recharts'
import { api, fmtSize } from '../api'
import type { SystemStats } from '../api'
import { TIP } from './charts'

const HIST = 30 // 30 lần đo x 3 giây = 90 giây gần nhất
const pct = (u: number, t: number) => (t ? Math.round((u / t) * 100) : 0)
const tone = (p: number) => (p >= 90 ? '#dc2626' : p >= 70 ? '#f59e0b' : '#14919b')

function Gauge({ label, value, sub }: { label: string; value: number | null; sub: string }) {
  const v = value ?? 0
  return (
    <div className="flex flex-col items-center text-center" role="img" aria-label={`${label}: ${value == null ? 'không có dữ liệu' : `${v}%`}, ${sub}`}>
      <div className="relative">
        <RadialBarChart width={88} height={88} innerRadius="78%" outerRadius="100%" data={[{ v, fill: tone(v) }]} startAngle={90} endAngle={-270}>
          <PolarAngleAxis type="number" domain={[0, 100]} tick={false} />
          <RadialBar dataKey="v" background={{ fill: '#e6f5f6' }} cornerRadius={6} isAnimationActive={false} />
        </RadialBarChart>
        <span className="absolute inset-0 flex items-center justify-center font-display text-base font-semibold text-navy">{value == null ? '–' : `${v}%`}</span>
      </div>
      <p className="mt-1 text-sm font-medium text-ink">{label}</p>
      <p className="text-xs text-muted">{sub}</p>
    </div>
  )
}

export default function DeviceStatus() {
  const [s, setS] = useState<SystemStats | null>(null)
  const [hist, setHist] = useState<{ t: string; cpu: number; gpu: number | null }[]>([])
  const [err, setErr] = useState('')

  useEffect(() => {
    let alive = true
    const tick = () => api.system()
      .then(r => {
        if (!alive) return
        setS(r); setErr('')
        setHist(h => [...h, { t: new Date().toLocaleTimeString('vi-VN'), cpu: r.cpu, gpu: r.gpu?.util ?? null }].slice(-HIST))
      })
      .catch((e: Error) => { if (alive) setErr(e.message) })
    tick()
    const id = setInterval(tick, 3000)
    return () => { alive = false; clearInterval(id) }
  }, [])

  if (!s) return err
    ? <p className="text-sm text-danger">Không đọc được trạng thái máy: {err}</p>
    : <div className="h-48 animate-pulse rounded-lg bg-canvas" aria-busy="true" aria-label="Đang tải" />

  const g = s.gpu
  const dp = pct(s.disk.used, s.disk.total)
  return (
    <div className="flex flex-1 flex-col gap-3">
      {err && <p className="text-xs text-danger">Mất kết nối, đang hiện số đo cũ: {err}</p>}
      <div className="grid grid-cols-2 gap-3 xl:grid-cols-4">
        <Gauge label="CPU" value={s.cpu} sub={`${s.cores} luồng · tải ${s.load.toFixed(1)}`} />
        <Gauge label="GPU" value={g ? g.util : null} sub={g ? `${g.temp}°C` : 'không đọc được'} />
        <Gauge label="RAM" value={pct(s.ram.used, s.ram.total)} sub={`${fmtSize(s.ram.used)} / ${fmtSize(s.ram.total)}`} />
        <Gauge label="VRAM" value={g ? pct(g.mem_used, g.mem_total) : null} sub={g ? `${fmtSize(g.mem_used)} / ${fmtSize(g.mem_total)}` : 'không đọc được'} />
      </div>
      <div>
        <div className="flex justify-between gap-2 text-xs">
          <span className="text-ink">Ổ đĩa dữ liệu</span>
          <span className="text-muted">{fmtSize(s.disk.used)} / {fmtSize(s.disk.total)} · {dp}%</span>
        </div>
        <div className="mt-1 h-2 overflow-hidden rounded-full bg-primary-soft" role="progressbar" aria-valuenow={dp} aria-valuemin={0} aria-valuemax={100} aria-label="Dung lượng ổ đĩa dữ liệu">
          <div className="h-full rounded-full" style={{ width: `${dp}%`, background: tone(dp) }} />
        </div>
      </div>
      <div className="relative min-h-28 flex-1" role="img" aria-label={`Tải CPU và GPU trong ${hist.length} lần đo gần nhất, hiện tại CPU ${s.cpu}%, GPU ${g ? `${g.util}%` : 'không rõ'}`}>
        <div className="absolute inset-0">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={hist} margin={{ top: 4, right: 4, left: -24, bottom: 0 }}>
              <XAxis dataKey="t" hide />
              <YAxis domain={[0, 100]} tick={{ fontSize: 11, fill: '#6b7280' }} axisLine={false} tickLine={false} />
              <Tooltip formatter={(v, n) => [`${v}%`, n]} contentStyle={TIP} />
              <Line dataKey="cpu" name="CPU" stroke="#14919b" strokeWidth={2} dot={false} isAnimationActive={false} />
              <Line dataKey="gpu" name="GPU" stroke="#3b6fb6" strokeWidth={2} dot={false} isAnimationActive={false} connectNulls />
            </LineChart>
          </ResponsiveContainer>
        </div>
      </div>
      <p className="flex items-center gap-3 text-xs text-muted">
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#14919b]" aria-hidden="true" />CPU</span>
        <span className="flex items-center gap-1"><span className="h-2 w-3 rounded-sm bg-[#3b6fb6]" aria-hidden="true" />GPU</span>
        <span className="ml-auto">90 giây gần nhất</span>
      </p>
    </div>
  )
}
