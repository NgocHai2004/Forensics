import { useState } from 'react'
import { HardDrive, Smartphone, Tablet } from 'lucide-react'

// Ảnh thật của máy (thư mục data/deviceimg/models hoặc Wikipedia qua /api/device-image); không có ảnh -> icon tương tự.
export function DeviceThumb({ name, serial, ios, type, className = 'h-8 w-8' }: {
  name: string
  serial?: string | null
  ios?: boolean
  type?: string
  className?: string
}) {
  const [err, setErr] = useState(false)
  if (type === 'hdd') return <HardDrive className={className} strokeWidth={1.5} aria-hidden="true" />
  if (err || !name) {
    // mã TB…/iPad/Tab = máy tính bảng
    return /ipad|\btab\b|\bTB-?\d/i.test(name)
      ? <Tablet className={className} strokeWidth={1.5} aria-hidden="true" />
      : <Smartphone className={className} strokeWidth={1.5} aria-hidden="true" />
  }
  return (
    <img
      src={`/api/device-image?v=4&serial=${encodeURIComponent(serial ?? '')}&ios=${!!ios}&name=${encodeURIComponent(name)}`}
      onError={() => setErr(true)}
      className="h-full w-full object-contain"
      alt={name}
    />
  )
}
