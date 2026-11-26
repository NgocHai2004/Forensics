// Client duy nhất cho backend FastAPI (app/main.py). Mọi page import từ đây, không fetch trực tiếp.

export type Kind = 'image' | 'video' | 'audio' | 'document' | 'other'
export const KIND_LABEL: Record<Kind, string> = { image: 'Ảnh', video: 'Video', audio: 'Âm thanh', document: 'Tài liệu', other: 'Khác' }

export interface FileItem {
  id: number
  path: string
  name: string
  ext: string
  kind: Kind
  size: number
  mtime: string           // 'YYYY-MM-DDTHH:MM:SS'
  sha256: string
  taken_at: string | null
  lat: number | null
  lon: number | null
  width: number | null
  height: number | null
  caption: string | null
  ocr_text: string | null
  tags: string | null     // JSON array string
  text_content: string | null
  thumb: string | null
  indexed_at: string
  error: string | null
  thumb_url: string | null  // '/thumb/<id>'
  file_url: string          // '/file/<id>'
  collection: string | null // bộ dữ liệu (phân loại) khi index/upload
  device: string | null     // thiết bị thu giữ (devices.name) trong vụ án
}

export interface IndexRun {
  id: number
  folder: string
  started_at: string
  finished_at: string | null
  total: number
  done: number
  status: 'running' | 'done' | 'error'
  message: string | null
}

export interface Stats {
  total: number
  total_size: number
  by_kind: Partial<Record<Kind, number>>
  by_month: { month: string; count: number }[]   // month 'YYYY-MM', tăng dần
  by_day: { day: string; count: number }[]       // 7 ngày gần nhất 'YYYY-MM-DD', tăng dần, ngày trống = 0
  with_gps: number
  captioned: number
  errors: number
  last_run: IndexRun | null
}

export interface SystemStats {
  cpu: number                  // % toàn máy
  cores: number
  load: number                 // load average 1 phút
  ram: { used: number; total: number }    // byte
  disk: { used: number; total: number }   // byte, ổ chứa dữ liệu index
  gpu: { name: string; util: number; mem_used: number; mem_total: number; temp: number } | null  // null khi không đọc được nvidia-smi
}

export interface User { username: string; created_at: string }

export interface FilesPage { items: FileItem[]; total: number; page: number; limit: number }

export interface ChatMsg { role: 'user' | 'assistant'; content: string }

// loc: "00:02:10" (audio/video) | "trang 3" | "slide 4" | "Sheet1 dòng 5" | null
export interface Source { id: number; name: string; kind: Kind; thumb_url: string | null; file_url: string; caption: string | null; loc: string | null }

/** Link mở đúng vị trí: thời gian -> media fragment #t=<giây>, "trang N" -> #page=N (trình xem PDF). */
export const locUrl = (url: string, loc?: string | null) => {
  if (!loc) return url
  if (/^\d{1,2}(:\d{2}){1,2}$/.test(loc)) return `${url}#t=${loc.split(':').reduce((a, x) => a * 60 + Number(x), 0)}`
  const p = /^trang (\d+)$/i.exec(loc)
  return p ? `${url}#page=${p[1]}` : url
}

export interface AskResult { answer: string; sources: Source[] }

export type IndexStatus = IndexRun | { status: 'idle' }

export interface Case {
  name: string                 // = files.collection
  note: string | null
  created_at: string
  count: number
  by_kind: Partial<Record<Kind, number>>
  device_count: number         // số thiết bị thu giữ trong vụ án
}

// Gói chứng cứ đã đóng gói (app/packaging.py): archive tar.gz + manifest SHA256
export interface PackageItem {
  id: number
  source: string
  name: string
  size: number
  sha256: string
  status: 'pending' | 'running' | 'done' | 'error' | 'verified' | 'corrupt'
  error: string | null
  created_at: string
}

// Nhật ký hoạt động (audit log): chuỗi hành động trên vụ án/thiết bị/gói chứng cứ
export interface AuditEntry { id: number; created_at: string; action: string; target: string | null; detail: string | null }

// Phiên thu thập (mỗi lần pull điện thoại): mã phiên, thiết bị, thời gian, dung lượng, trạng thái
export interface SessionItem {
  id: number; case_name: string; device: string; operator: string | null
  started_at: string; finished_at: string | null; bytes: number
  status: 'running' | 'done' | 'error'; error: string | null
}

export interface DeviceAcqState {
  running: boolean
  case: string
  device: string
  serial: string | null
  stage: 'new' | 'imaging' | 'imaged' | 'partial' | 'extracting' | 'done' | 'error'
  phase: 'count' | 'pull' | 'package' | 'index' | 'ai' | null
  files: number
  total_files: number
  bytes: number
  total_bytes: number
  pct: number
  done: boolean
  error: string | null
  log: string
  image_sha256: string | null
  image_name: string | null
}

export type DeviceType = 'laptop' | 'hdd' | 'phone' | 'camera' | 'video' | 'other'
export interface Device {
  name: string; type: DeviceType; note: string | null; created_at: string; count: number
  serial?: string | null                    // máy đã đóng image: serial để nhận lại khi cắm
  stage?: 'new' | 'imaged' | 'partial' | 'done'  // suy từ dữ liệu: có gói image / trích xuất dở (bị ngắt) / xong
  image_sha256?: string | null; image_name?: string | null
  size?: number                             // tổng dung lượng dữ liệu đã trích xuất (byte)
  raw_size?: number; raw_count?: number    // chưa trích xuất xong: dữ liệu thô đã thu về
  index_run?: { status: 'running' | 'done' | 'error'; done: number; total: number; message: string | null } | null
  info?: DeviceInfo                         // thông tin máy đọc từ dữ liệu đã thu
}
// Đồng bộ về hệ thống trung tâm: lần gần nhất của mỗi thiết bị (skipped = chưa đóng image, không vào hàng chờ)
export interface SyncItem {
  device: string; status: 'pending' | 'sending' | 'done' | 'error' | 'skipped'; error?: string | null
  package_name?: string; sha256?: string; size?: number; created_at?: string
}
// Thông tin máy từ getprop/dumpsys (Android) hoặc ideviceinfo (iPhone) đã thu; storage_* = bộ nhớ máy (byte)
export interface DeviceInfo {
  name?: string | null; model?: string | null; os?: string | null; patch?: string | null; build?: string | null
  serial?: string | null; sim?: string | null; imei?: string | null; phone?: string | null
  storage_total?: number; storage_free?: number
}

// Ổ đĩa vật lý máy chủ (NVMe/M.2, SATA, USB) từ /sys/block — chỉ nhận diện, không đọc nội dung
export interface DiskItem { name: string; size: number; model: string | null; serial: string | null; transport: string; partitions: number }

// Trạng thái thiết bị ADB (cảnh báo chủ động): state = device (sẵn sàng) | unauthorized | offline | ...
export interface PhoneStatus { devices: { serial: string; state: string }[]; bad: { serial: string; state: string }[] }

// type: case | device | phone | email | plate | imei; name: tên trong danh bạ (SĐT); files: số tài liệu nhắc tới / của thiết bị
// cases: số vụ án cùng nhắc tới thực thể này (chỉ có ở sơ đồ tất cả vụ án)
export interface GraphNode { id: string; type: string; label: string; dtype?: DeviceType; name?: string | null; files?: number; cases?: number }
// rels: [loại liên kết, số lần]; ev: dòng bằng chứng (file id, tên file, vị trí, câu gốc), tối đa 30
export interface Evidence { id: number; file: string; loc: string | null; text: string }
export interface GraphEdge { from: string; to: string; rels: [string, number][]; n: number; ev: Evidence[] }
export interface Graph { nodes: GraphNode[]; edges: GraphEdge[] }

export class ApiError extends Error {
  status: number
  constructor(status: number, message: string) { super(message); this.status = status }
}

async function req<T>(url: string, body?: unknown): Promise<T> {
  const r = await fetch(url, body === undefined ? undefined : {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  })
  const data = await r.json().catch(() => ({}))
  if (!r.ok) throw new ApiError(r.status, typeof data.detail === 'string' ? data.detail : r.status >= 500 ? 'Máy chủ đang khởi động lại hoặc bận, thử lại sau giây lát' : `HTTP ${r.status}`)
  return data as T
}

// Bộ lọc tệp trên toàn bộ vụ án (server); giá trị rỗng/false thì bỏ khỏi URL
export interface FileQuery { collection: string; device?: string; store?: string; cloud?: boolean; q?: string; date_from?: string; date_to?: string; src?: string }
const fileQs = (p: FileQuery & { obj?: string; page?: number }) =>
  new URLSearchParams(Object.entries(p).filter(([, v]) => v !== undefined && v !== '' && v !== false).map(([k, v]) => [k, String(v)]))

export const api = {
  stats: () => req<Stats>('/api/stats'),
  system: () => req<SystemStats>('/api/system'),
  users: () => req<User[]>('/api/users'),
  createUser: (username: string, password: string) => req<User>('/api/users', { username, password }),
  login: (username: string, password: string) => req<{ username: string; open: boolean }>('/api/login', { username, password }),
  // Tải đủ mọi trang (server giới hạn 200/lần) để danh sách và số đếm khớp tổng thật của vụ án.
  // shortcut: chỉ tải 20.000 tệp mới nhất (149k tệp ~ 575 MB JSON làm treo trình duyệt); cần phân trang phía server nếu muốn duyệt hết
  allFiles: async (collection: string, max = 20000) => {
    const first = await api.files({ collection, page: 1, limit: 200 })
    const items: FileItem[] = [...first.items]
    const pages = Math.min(Math.ceil(first.total / 200), max / 200)
    for (let p = 2; p <= pages; p += 6) {
      const rs = await Promise.all(Array.from({ length: Math.min(6, pages - p + 1) }, (_, i) => api.files({ collection, page: p + i, limit: 200 })))
      for (const r of rs) items.push(...r.items)
    }
    return { items, total: first.total }
  },
  fileObjects: (p: FileQuery) => req<Record<string, number>>(`/api/files/objects?${fileQs(p)}`),
  fileApps: (collection: string, device?: string, cloud = false) =>
    req<{ src: string; n: number; size: number; by: Record<string, [number, number]> }[]>(
      `/api/files/apps?collection=${encodeURIComponent(collection)}${device ? `&device=${encodeURIComponent(device)}` : ''}${cloud ? '&cloud=true' : ''}`),
  fileSources: (p: FileQuery & { obj?: string }) => req<[string, number][]>(`/api/files/sources?${fileQs(p)}`),
  browseFiles: (p: FileQuery & { obj?: string; page: number }) => req<FilesPage>(`/api/files/browse?${fileQs(p)}`),
  fileStats: (collection: string, device?: string, cloud = false) =>
    req<{ by: Record<string, { n: number; size: number }>; n: number; size: number }>(
      `/api/files/stats?collection=${encodeURIComponent(collection)}${device ? `&device=${encodeURIComponent(device)}` : ''}${cloud ? '&cloud=true' : ''}`),
  files: (p: { kind?: Kind; q?: string; page?: number; limit?: number; collection?: string; device?: string } = {}) => {
    const qs = new URLSearchParams()
    if (p.kind) qs.set('kind', p.kind)
    if (p.q) qs.set('q', p.q)
    if (p.page) qs.set('page', String(p.page))
    if (p.limit) qs.set('limit', String(p.limit))
    if (p.collection) qs.set('collection', p.collection)
    if (p.device) qs.set('device', p.device)
    return req<FilesPage>(`/api/files?${qs}`)
  },
  file: (id: number) => req<FileItem>(`/api/files/${id}`),
  deleteFile: (c: string, id: number) => req<{ deleted: number; trashed: number }>('/api/files/delete', { case: c, id }),
  startIndex: (folder: string, collection?: string) =>
    req<{ status: 'started'; folder: string }>('/api/index', { folder, collection: collection || null }),
  indexStatus: () => req<IndexStatus>('/api/index/status'),
  collections: () => req<{ collection: string; count: number }[]>('/api/collections'),
  upload: async (files: File[], collection: string, device?: string) => {
    const fd = new FormData()
    fd.set('collection', collection)
    if (device) fd.set('device', device)
    // chọn thư mục: webkitRelativePath = "thư mục/con/file.jpg" -> server giữ nguyên cây thư mục
    for (const f of files) fd.append('files', f, f.webkitRelativePath || f.name)
    const r = await fetch('/api/upload', { method: 'POST', body: fd })  // không đặt Content-Type để browser tự thêm boundary
    const data = await r.json().catch(() => ({}))
    if (!r.ok) throw new ApiError(r.status, typeof data.detail === 'string' ? data.detail : r.status >= 500 ? 'Máy chủ đang khởi động lại hoặc bận, thử lại sau giây lát' : `HTTP ${r.status}`)
    return data as { saved: number; folder: string; status: 'started' }
  },
  cases: () => req<Case[]>('/api/cases'),
  createCase: (name: string, note?: string) => req<Case>('/api/cases', { name, note: note || null }),
  updateCase: (name: string, newName: string, note: string) => req<Case>('/api/cases/update', { name, new_name: newName, note: note || null }),
  deleteCase: (name: string) => req<{ deleted: number; trashed: number; trash: string | null }>('/api/cases/delete', { name }),
  devices: (c: string) => req<{ items: Device[]; unassigned: number }>(`/api/devices?case=${encodeURIComponent(c)}`),
  // adb: 'device' sẵn sàng | 'unauthorized' chờ cho phép | 'offline' | null = chưa bật gỡ lỗi USB (chỉ sạc/MTP)
  usb: () => req<{ items: { type: DeviceType; name: string; model?: string | null; serial?: string | null; usb_id?: string | null; ios?: boolean; adb?: string | null; block?: string | null; size?: number }[] }>('/api/usb'),
  disks: () => req<{ disks: DiskItem[] }>('/api/disk'),
  phoneSim: (serial?: string) => req<{ serial: string; props: Record<string, string> }>(`/api/phone/sim${serial ? `?serial=${encodeURIComponent(serial)}` : ''}`),
  phoneStatus: () => req<PhoneStatus>('/api/phone/status'),
  deviceStatus: () => req<{ items: DeviceAcqState[] }>('/api/device/status'),
  deviceEstimate: (serial: string) => req<{ bytes: number; files: number | null }>(`/api/device/estimate?serial=${encodeURIComponent(serial)}`),
  deviceImage: (c: string, device: string, serial?: string) => req<{ status: 'started'; serial: string }>('/api/device/image', { case: c, device, serial: serial || null }),
  deviceExtract: (c: string, device: string) => req<{ status: 'started' }>('/api/device/extract', { case: c, device }),
  syncs: (c: string) => req<{ items: SyncItem[] }>(`/api/sync?case=${encodeURIComponent(c)}`),
  syncQueue: (c: string, devices: string[]) => req<{ items: SyncItem[] }>('/api/sync', { case: c, devices }),
  pull: (c: string, device: string, serial?: string) => req<{ status: 'started'; serial: string }>('/api/pull', { case: c, device, serial: serial || null }),
  pullStatus: () => req<{ running: boolean; device: string | null; phase: 'count' | 'pull' | 'index' | null; files: number; total_files: number; bytes: number; total_bytes: number; pct: number; done: boolean; error: string | null; log: string; index?: { status: string; done: number; total: number } }>('/api/pull/status'),
  createDevice: (c: string, name: string, type: DeviceType) => req<Device>('/api/devices', { case: c, name, type }),
  deleteDevice: (c: string, name: string) => req<{ deleted: number; trashed: number }>('/api/devices/delete', { case: c, name }),
  createPackage: (c: string, device?: string) => req<{ status: 'started' }>('/api/image', { case: c, device: device || null }),
  images: (c: string) => req<PackageItem[]>(`/api/images?case=${encodeURIComponent(c)}`),
  verifyImage: (id: number) => req<{ status: string; mismatches: string[]; count: number }>(`/api/images/${id}/verify`),
  imageUrl: (id: number) => `/api/images/${id}/file`,
  audit: (limit = 50) => req<AuditEntry[]>(`/api/audit?limit=${limit}`),
  sessions: (c?: string) => req<SessionItem[]>(`/api/sessions${c ? `?case=${encodeURIComponent(c)}` : ''}`),
  graph: (c: string) => req<Graph>(`/api/graph?case=${encodeURIComponent(c)}`),
  graphAll: () => req<Graph>('/api/graph/all'),
  ask: (question: string, history: ChatMsg[], collection?: string, extra: string[] = []) =>
    req<AskResult>('/api/ask', { question, history, collection: collection || null, extra }),
}

export const fmtSize = (n: number) => {
  const u = ['B', 'KB', 'MB', 'GB', 'TB']; let i = 0
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++ }
  return `${i ? n.toFixed(1) : n} ${u[i]}`
}
