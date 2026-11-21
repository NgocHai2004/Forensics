import { useEffect, useMemo, useState } from 'react'
import type { FormEvent } from 'react'
import { useNavigate, useParams, useSearchParams } from 'react-router-dom'
import {
  Archive,
  Bookmark,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  LayoutGrid,
  Repeat,
  Rows3,
  Play,
  Download,
  FileText,
  HardDrive,
  Image as ImageIcon,
  Layers,
  MessageCircle,
  MessageSquare,
  Network,
  PhoneCall,
  Shield,
  Smartphone,
  Tag,
  Upload,
  User,
  Users,
  X,
  LogOut,
  Plus,
  Trash2,
} from 'lucide-react'
import { api, fmtSize } from '../api'
import type { Device, DeviceType, FileItem, Graph, PackageItem } from '../api'
import { graphHtml } from '../graphHtml'
import { useI18n } from '../i18n'
import { logout } from '../auth'

const VIS = '/vendor/vis-network.min.js'
const VIEWS = ['column', 'grid', 'conversation'] as const
const VIEW_LABEL = { column: 'Column view', grid: 'Grid view', conversation: 'Conversation view' } as const

export interface ArtifactItem {
  id: string
  category: 'chat' | 'call' | 'contact' | 'media' | 'document' | 'other'
  subCategory: string
  chatId: string
  profileName: string
  author: string
  recipient: string
  displayName: string
  timestamp: string
  content: string
  raw?: FileItem
  metadata: Record<string, string | number | null | undefined>
  threadId?: string
  threadMessages?: {
    id: string
    author: string
    timestamp: string
    text: string
    isOutgoing?: boolean
  }[]
}

const DEVICE_LABELS: Record<DeviceType, string> = {
  laptop: 'Laptop / PC',
  hdd: 'HDD / USB drive',
  phone: 'Phone',
  camera: 'Camera DVR',
  video: 'Video / Audio',
  other: 'Other',
}

export default function CaseDetail() {
  const name = useParams().name ?? ''
  const [sp, setSp] = useSearchParams()
  const activeDevice = sp.get('device') ?? ''

  // Dữ liệu vụ án
  const [devs, setDevs] = useState<{ items: Device[]; unassigned: number } | null>(null)
  const [files, setFiles] = useState<FileItem[]>([])
  const [loading, setLoading] = useState(true)
  const [err, setErr] = useState('')

  // Thiết bị đang kết nối thực tế (điện thoại ADB + USB) — poll 5s, giống Shell header.
  const [live, setLive] = useState<{ n: number; bad: number }>({ n: 0, bad: 0 })
  useEffect(() => {
    const tick = () => Promise.all([api.phoneStatus().catch(() => null), api.usb().catch(() => null)])
      .then(([ph, usb]) => setLive({
        n: usb?.items.length ?? 0,
        bad: (ph?.devices ?? []).filter(d => d.state !== 'device').length,
      }))
    tick()
    const id = setInterval(tick, 5000)
    return () => clearInterval(id)
  }, [])

  // Danh sách vụ án để chọn đổi dự án (app giờ chỉ có 1 trang Magnet).
  const [caseList, setCaseList] = useState<{ name: string }[]>([])
  const navigate = useNavigate()
  const { t } = useI18n()
  useEffect(() => {
    api.cases().then((cs) => setCaseList(cs)).catch(() => {})
  }, [])

  // State bộ lọc và chế độ xem Magnet AXIOM
  const [selectedCategory, setSelectedCategory] = useState<string>('all')
  const [selectedSubCategory, setSelectedSubCategory] = useState<string>('all')
  const [searchQuery, setSearchQuery] = useState('')
  const [activeSearch, setActiveSearch] = useState('')
  // Bộ lọc nâng cao: khoảng ngày, người vật, chỉ hiện bản ghi có QR
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo] = useState('')
  const [person, setPerson] = useState('all')
  const [qrOnly, setQrOnly] = useState('all')
  const [selectedArtifactId, setSelectedArtifactId] = useState<string | null>(null)
  const [viewMode, setViewMode] = useState<'column' | 'conversation' | 'grid'>('column')
  const nextView = VIEWS[(VIEWS.indexOf(viewMode) + 1) % VIEWS.length]
  const [lightbox, setLightbox] = useState(false)
  const [activeThreadId, setActiveThreadId] = useState<string | null>(null)
  const [showTagsDrawer, setShowTagsDrawer] = useState(false)

  // Tags & Ghi chú nghiệp vụ
  const [itemTags, setItemTags] = useState<Record<string, string[]>>({
    default: ['Quan trọng', 'Ma túy'],
  })
  const [itemNotes, setItemNotes] = useState<Record<string, string>>({
    default: 'Chứng cứ liên lạc điều phối vận chuyển.',
  })
  const [newTagInput, setNewTagInput] = useState('')
  const [currentNoteInput, setCurrentNoteInput] = useState('')

  // Modals tác vụ
  const [openCollectModal, setOpenCollectModal] = useState(false)
  const [openUploadModal, setOpenUploadModal] = useState(false)
  const [openPackageModal, setOpenPackageModal] = useState(false)
  const [openDeviceMgrModal, setOpenDeviceMgrModal] = useState(false)
  const [openGraphModal, setOpenGraphModal] = useState(false)
  const [openCaseMgrModal, setOpenCaseMgrModal] = useState(false)

  // Nạp dữ liệu vụ án từ Backend API
  const loadData = async () => {
    try {
      setLoading(true)
      const [d, f] = await Promise.all([
        api.devices(name),
        api.allFiles(name),
      ])
      setDevs(d)
      setFiles(f)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Cannot load case data'))
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    loadData()
  }, [name])

  // Trích xuất các tệp chứng cứ thực tế thành các Artifacts chuẩn Magnet AXIOM
  const artifacts = useMemo<ArtifactItem[]>(() => {
    const list: ArtifactItem[] = []

    for (const f of files) {
      const devName = f.device || 'Unassigned device'
      const baseMeta = {
        'File name': f.name,
        'Seized device': devName,
        'Size': fmtSize(f.size),
        'Modified time': f.mtime.replace('T', ' '),
        'SHA-256 hash': f.sha256,
        'Original path': f.path,
        'AI description': f.caption || null,
        'OCR text': f.ocr_text || null,
      }

      // 1. Tin nhắn SMS / Zalo / Chat
      if (
        f.name.toLowerCase().includes('tin_nhan') ||
        f.name.toLowerCase().includes('sms') ||
        f.name.toLowerCase().includes('chat') ||
        f.name.toLowerCase().includes('zalo')
      ) {
        if (f.text_content) {
          const lines = f.text_content.split('\n')
          const isZalo = f.name.toLowerCase().includes('zalo')
          const subCat = isZalo ? 'Zalo / OTT chat' : 'SMS / MMS'
          const threadMsgs: {
            id: string
            author: string
            timestamp: string
            text: string
            isOutgoing?: boolean
          }[] = []

          lines.forEach((line, idx) => {
            if (!line.trim() || line.toLowerCase().includes('thời gian | từ')) return
            const parts = line.split('|').map((p) => p.trim())
            if (parts.length >= 4) {
              const timeStr = parts[0].replace(/csv dòng \d+:\s*/i, '').trim()
              const sender = parts[1]
              const recipient = parts[2]
              const content = parts.slice(3).join(' | ')
              const isOut = idx % 2 === 0
              const threadKey = `${sender} ↔ ${recipient}`

              const msgObj = {
                id: `chat-${f.id}-${idx}`,
                author: sender,
                timestamp: timeStr,
                text: content,
                isOutgoing: isOut,
              }
              threadMsgs.push(msgObj)

              list.push({
                id: `chat-${f.id}-${idx}`,
                category: 'chat',
                subCategory: subCat,
                chatId: threadKey,
                profileName: sender,
                author: sender,
                recipient: recipient,
                displayName: sender,
                timestamp: timeStr,
                content: content,
                raw: f,
                threadId: threadKey,
                metadata: {
                  ...baseMeta,
                  'Sender': sender,
                  'Recipient': recipient,
                  'Sent time': timeStr,
                  'Message text': content,
                },
                threadMessages: [msgObj],
              })
            }
          })

          if (threadMsgs.length > 0) {
            list.forEach((item) => {
              if (item.category === 'chat' && item.raw?.id === f.id) {
                item.threadMessages = threadMsgs
              }
            })
            continue
          }
        }
      }

      // 2. Nhật ký cuộc gọi (Call logs)
      if (f.name.toLowerCase().includes('cuoc_goi') || f.name.toLowerCase().includes('call')) {
        if (f.text_content) {
          const lines = f.text_content.split('\n')
          lines.forEach((line, idx) => {
            if (!line.trim() || line.toLowerCase().includes('thời gian | số')) return
            const parts = line.split('|').map((p) => p.trim())
            if (parts.length >= 4) {
              const timeStr = parts[0].replace(/csv dòng \d+:\s*/i, '').trim()
              const phone = parts[1]
              const direction = parts[2]
              const duration = parts[3]
              list.push({
                id: `call-${f.id}-${idx}`,
                category: 'call',
                subCategory: direction.includes('đi') ? 'Outgoing call' : 'Incoming call',
                chatId: phone,
                profileName: phone,
                author: direction.includes('đi') ? 'Device owner' : phone,
                recipient: direction.includes('đi') ? phone : 'Device owner',
                displayName: `${phone} (${direction})`,
                timestamp: timeStr,
                content: `Call: ${direction} · Duration: ${duration}s`,
                raw: f,
                metadata: {
                  ...baseMeta,
                  'Phone number': phone,
                  'Call direction': direction,
                  'Duration (s)': duration,
                  'Time': timeStr,
                },
              })
            }
          })
          continue
        }
      }

      // 3. Danh bạ điện thoại (Contacts)
      if (f.name.toLowerCase().includes('danh_ba') || f.name.toLowerCase().includes('contact')) {
        if (f.text_content) {
          const lines = f.text_content.split('\n')
          lines.forEach((line, idx) => {
            if (!line.trim() || line.toLowerCase().includes('tên | số điện thoại')) return
            const parts = line.split('|').map((p) => p.trim())
            if (parts.length >= 2) {
              const contactName = parts[0].replace(/csv dòng \d+:\s*/i, '').trim()
              const phone = parts[1]
              const email = parts[2] || ''
              list.push({
                id: `contact-${f.id}-${idx}`,
                category: 'contact',
                subCategory: 'Phone contacts',
                chatId: phone,
                profileName: contactName,
                author: contactName,
                recipient: phone,
                displayName: contactName,
                timestamp: f.mtime.replace('T', ' '),
                content: `Phone: ${phone}${email ? ` · Email: ${email}` : ''}`,
                raw: f,
                metadata: {
                  ...baseMeta,
                  'Full name': contactName,
                  'Phone number': phone,
                  'Email': email || 'None',
                },
              })
            }
          })
          continue
        }
      }

      // 4. Nhật ký Camera giám sát
      if (f.name.toLowerCase().includes('camera')) {
        list.push({
          id: `cam-${f.id}`,
          category: 'media',
          subCategory: 'Camera log',
          chatId: f.name,
          profileName: devName,
          author: 'Camera system',
          recipient: 'Storage server',
          displayName: f.name,
          timestamp: f.mtime.replace('T', ' '),
          content: f.text_content ? f.text_content.slice(0, 160) : f.name,
          raw: f,
          metadata: baseMeta,
        })
        continue
      }

      // 5. Hình ảnh & Video
      if (f.kind === 'image' || f.kind === 'video' || f.kind === 'audio') {
        list.push({
          id: `media-${f.id}`,
          category: 'media',
          subCategory: f.kind === 'image' ? 'Photos / Video' : 'Video recording',
          chatId: f.name,
          profileName: devName,
          author: devName,
          recipient: 'Storage',
          displayName: f.name,
          timestamp: f.taken_at ? f.taken_at.replace('T', ' ') : f.mtime.replace('T', ' '),
          content: f.caption || (f.ocr_text ? `OCR: ${f.ocr_text.slice(0, 100)}` : f.name),
          raw: f,
          metadata: {
            ...baseMeta,
            'Resolution': f.width && f.height ? `${f.width} x ${f.height}` : null,
            'GPS coordinates': f.lat !== null && f.lon !== null ? `${f.lat}, ${f.lon}` : null,
          },
        })
        continue
      }

      // 6. Giao dịch & Tài chính
      if (f.name.toLowerCase().includes('giao_dich') || f.name.toLowerCase().includes('momo')) {
        list.push({
          id: `trans-${f.id}`,
          category: 'document',
          subCategory: 'Transaction log',
          chatId: f.name,
          profileName: devName,
          author: devName,
          recipient: 'E-wallet / Bank',
          displayName: f.name,
          timestamp: f.mtime.replace('T', ' '),
          content: f.text_content ? f.text_content.slice(0, 160) : f.name,
          raw: f,
          metadata: baseMeta,
        })
        continue
      }

      // 7. Tài liệu văn bản khác
      list.push({
        id: `doc-${f.id}`,
        category: 'document',
        subCategory: 'Documents & Notes',
        chatId: f.name,
        profileName: devName,
        author: devName,
        recipient: 'Device storage',
        displayName: f.name,
        timestamp: f.mtime.replace('T', ' '),
        content: f.text_content ? f.text_content.slice(0, 160) : f.name,
        raw: f,
        metadata: baseMeta,
      })
    }

    return list
  }, [files])

  // Lọc dữ liệu theo thiết bị, danh mục và từ khóa tìm kiếm
  // Danh sách người vật xuất hiện trong vụ án (người gửi/nhận/tên hiển thị/chủ hồ sơ)
  const persons = useMemo(() => {
    const set = new Set<string>()
    for (const a of artifacts) {
      for (const v of [a.author, a.recipient, a.displayName, a.profileName]) {
        const t = (v || '').trim()
        if (t && t !== '-' && t.length < 80) set.add(t)
      }
    }
    return Array.from(set).sort((x, y) => x.localeCompare(y))
  }, [artifacts])

  const filteredArtifacts = useMemo(() => {
    return artifacts.filter((a) => {
      if (activeDevice && a.raw?.device !== activeDevice) return false
      if (selectedCategory !== 'all' && a.category !== selectedCategory) return false
      if (selectedSubCategory !== 'all' && a.subCategory !== selectedSubCategory) return false
      if (activeSearch.trim()) {
        const q = activeSearch.toLowerCase()
        const matchName = a.displayName?.toLowerCase().includes(q)
        const matchContent = a.content?.toLowerCase().includes(q)
        const matchAuthor = a.author?.toLowerCase().includes(q)
        const matchRecip = a.recipient?.toLowerCase().includes(q)
        const matchId = a.chatId?.toLowerCase().includes(q)
        if (!matchName && !matchContent && !matchAuthor && !matchRecip && !matchId) return false
      }
      if (dateFrom || dateTo) {
        const d = (a.timestamp || '').slice(0, 10)
        if (!d) return false
        if (dateFrom && d < dateFrom) return false
        if (dateTo && d > dateTo) return false
      }
      if (person !== 'all') {
        const pl = person.toLowerCase()
        const hit = [a.author, a.recipient, a.displayName, a.profileName, a.chatId].some(
          (v) => (v || '').toLowerCase().includes(pl)
        )
        if (!hit) return false
      }
      if (qrOnly === 'qr') {
        const hay = [a.content, a.displayName, ...(a.metadata ? Object.values(a.metadata) : [])]
          .map((v) => String(v ?? '').toLowerCase())
        if (!hay.some((v) => v.includes('qr'))) return false
      }
      return true
    })
  }, [artifacts, activeDevice, selectedCategory, selectedSubCategory, activeSearch, dateFrom, dateTo, person, qrOnly])

  // Thống kê số lượng từng danh mục
  const categoryCounts = useMemo(() => {
    const c: Record<string, number> = {
      all: artifacts.length,
      chat: 0,
      call: 0,
      contact: 0,
      media: 0,
      document: 0,
      other: 0,
    }
    const sub: Record<string, number> = {}

    for (const a of artifacts) {
      if (activeDevice && a.raw?.device !== activeDevice) continue
      c[a.category] = (c[a.category] || 0) + 1
      sub[a.subCategory] = (sub[a.subCategory] || 0) + 1
    }
    return { c, sub }
  }, [artifacts, activeDevice])

  // Artifact được chọn
  const selectedArtifact = useMemo(() => {
    if (!filteredArtifacts.length) return null
    return filteredArtifacts.find((a) => a.id === selectedArtifactId) || filteredArtifacts[0]
  }, [filteredArtifacts, selectedArtifactId])

  // Grid view kiểu app Ảnh iPhone: chỉ ảnh/video/âm thanh trong bộ lọc hiện tại; bấm ô mở xem lớn
  const gridItems = useMemo(() => filteredArtifacts.filter((a) => a.category === 'media'), [filteredArtifacts])
  const li = gridItems.findIndex((a) => a.id === selectedArtifactId)
  const lbItem = lightbox && li >= 0 ? gridItems[li] : null
  const go = (step: number) => setSelectedArtifactId(gridItems[(li + step + gridItems.length) % gridItems.length].id)
  useEffect(() => {
    if (!lbItem) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setLightbox(false)
      else if (e.key === 'ArrowRight') go(1)
      else if (e.key === 'ArrowLeft') go(-1)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  // Nhóm danh sách hội thoại cho Conversation View
  const conversationThreads = useMemo(() => {
    const map = new Map<
      string,
      { threadId: string; title: string; count: number; lastMsg: string; timestamp: string }
    >()
    for (const a of artifacts) {
      if (a.category !== 'chat') continue
      const tid = a.threadId || a.chatId || 'Chung'
      if (!map.has(tid)) {
        map.set(tid, {
          threadId: tid,
          title: a.displayName || a.chatId,
          count: 1,
          lastMsg: a.content,
          timestamp: a.timestamp,
        })
      } else {
        const t = map.get(tid)!
        t.count += 1
        t.lastMsg = a.content
        t.timestamp = a.timestamp
      }
    }
    return Array.from(map.values())
  }, [artifacts])

  return (
    <div className="flex flex-col h-screen w-screen bg-[#f0f3f6] text-[#1c2d42] font-sans overflow-hidden select-none">
      {/* =========================================================================
          ROW 1: MAGNET AXIOM TOP BAR
          ========================================================================= */}
      <header className="shrink-0 bg-[#0f2a4a] text-white border-b border-[#0d233e]">
        {/* Hàng 1: Tiêu đề vụ án & Toolbar các nút tác vụ */}
        <div className="flex h-11 items-center justify-between px-3">
          <div className="flex items-center gap-3 min-w-0">
            <select
              value={name}
              onChange={(e) => navigate(`/cases/${encodeURIComponent(e.target.value)}`)}
              title="Chọn vụ án / dự án"
              className="inline-flex items-center max-w-[220px] rounded bg-white/10 hover:bg-white/20 text-white px-2 py-1 text-xs font-medium transition-colors cursor-pointer outline-none [&>option]:text-navy"
            >
              {caseList.length === 0 && <option value={name}>{name}</option>}
              {caseList.map((c) => (
                <option key={c.name} value={c.name}>{c.name}</option>
              ))}
            </select>
            <button
              type="button"
              onClick={() => setOpenCaseMgrModal(true)}
              title="Quản lý vụ án (tạo / sửa / xoá)"
              className="inline-flex items-center gap-1 rounded bg-white/10 hover:bg-[#2f6fed] text-white px-1.5 py-1 text-[11px] font-medium cursor-pointer transition-colors"
            >
              <Plus size={13} />
            </button>
            <div className="h-4 w-px bg-white/20" />
            <div className="flex items-center gap-2 truncate">
              <span className="text-xs font-bold uppercase tracking-wider text-[#4a7dff]">
                MAGNET AXIOM EXAMINE
              </span>
              <span className="text-xs text-slate-400">&bull;</span>
              <span className="text-sm font-bold text-white truncate" title={name}>
                {name || 'vụ án c1'}
              </span>
            </div>
          </div>

          {/* Các nút tác vụ: Thu thập ADB, Tải tệp, Đóng gói, Thiết bị, Sơ đồ */}
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setOpenCollectModal(true)}
              className="inline-flex items-center gap-1.5 rounded bg-[#2f6fed] hover:bg-[#2458c9] text-white px-2.5 py-1 text-xs font-medium transition-all shadow-xs cursor-pointer"
            >
              <Smartphone size={13} />
              <span>{t('Collect USB / ADB')}</span>
            </button>
            <button
              type="button"
              onClick={() => setOpenUploadModal(true)}
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <Upload size={13} />
              <span>{t('Upload files')}</span>
            </button>
            <button
              type="button"
              onClick={() => setOpenPackageModal(true)}
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <Archive size={13} />
              <span>{t('Package & Report')}</span>
            </button>
            <button
              type="button"
              onClick={() => setOpenDeviceMgrModal(true)}
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-white/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer"
            >
              <HardDrive size={13} />
              <span>{t('Devices')} ({devs?.items.length || 0})</span>
              <span
                className={`ml-0.5 inline-flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] font-semibold ${live.bad ? 'bg-red-500/20 text-red-300' : live.n ? 'bg-[#4a7dff]/20 text-[#4a7dff]' : 'bg-white/10 text-slate-400'}`}
                title="Devices connected"
              >
                <span className={`h-1.5 w-1.5 rounded-full ${live.bad ? 'bg-red-400' : live.n ? 'bg-[#4a7dff]' : 'bg-slate-400'}`} aria-hidden="true" />
                {live.n > 0 ? `${t('Connected')}: ${live.n}${live.bad ? ` · ${live.bad} ${t('errors')}` : ''}` : t('No connection')}
              </span>
            </button>
            <button
              type="button"
              onClick={() => { logout(); navigate('/login') }}
              title="Sign out"
              className="inline-flex items-center gap-1.5 rounded bg-white/10 hover:bg-red-500/20 text-white px-2.5 py-1 text-xs font-medium transition-colors cursor-pointer ml-1"
            >
              <LogOut size={13} />
              <span>{t('Sign out')}</span>
            </button>
          </div>
        </div>

        {/* =====================================================================
            ROW 2: FILTERS BAR
            ===================================================================== */}
        <div className="flex h-9 items-center justify-between bg-[#14375e] px-3 text-xs border-t border-white/10">
          <div className="flex items-center gap-1.5 overflow-x-auto py-1 scrollbar-none">
            <span className="font-bold tracking-wider text-slate-300 mr-2 text-[11px]">{t('FILTERS')}</span>

            {/* Filter: Thiết bị thu giữ */}
            <div className="relative inline-flex items-center">
              <select
                value={activeDevice}
                onChange={(e) => setSp(e.target.value ? { device: e.target.value } : {})}
                className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-2 pr-6 text-[11px] appearance-none cursor-pointer focus:outline-none focus:border-[#4a7dff]"
              >
                <option value="">{t('Evidence: ')}{t('All devices')}</option>
                {devs?.items.map((d) => (
                  <option key={d.name} value={d.name}>
                    {d.name} ({t(DEVICE_LABELS[d.type])})
                  </option>
                ))}
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1.5 text-slate-300" />
            </div>

            {/* Filter: Danh mục Artifacts */}
            <div className="relative inline-flex items-center">
              <select
                value={selectedCategory}
                onChange={(e) => {
                  setSelectedCategory(e.target.value)
                  setSelectedSubCategory('all')
                }}
                className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-2 pr-6 text-[11px] appearance-none cursor-pointer focus:outline-none focus:border-[#4a7dff]"
              >
                <option value="all">{t('Artifacts: ')}{t('All types')}</option>
                <option value="chat">{t('Messages & Chats (CHAT)')}</option>
                <option value="call">{t('Call logs (CALLS)')}</option>
                <option value="contact">{t('Contacts (CONTACTS)')}</option>
                <option value="media">{t('Images & Video (MEDIA)')}</option>
                <option value="document">{t('Documents & Logs')}</option>
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1.5 text-slate-300" />
            </div>

            {/* Bộ lọc Date & Tags */}
            <span className="inline-flex items-center gap-1 text-[11px] font-bold tracking-wider text-slate-300">Từ</span>
            <input
              type="date"
              value={dateFrom}
              onChange={(e) => setDateFrom(e.target.value)}
              className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-1.5 text-[11px] cursor-pointer focus:outline-none focus:border-[#4a7dff]"
            />
            <span className="inline-flex items-center gap-1 text-[11px] font-bold tracking-wider text-slate-300">Đến</span>
            <input
              type="date"
              value={dateTo}
              onChange={(e) => setDateTo(e.target.value)}
              className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-1.5 text-[11px] cursor-pointer focus:outline-none focus:border-[#4a7dff]"
            />

            {/* Bộ lọc người vật */}
            <div className="relative inline-flex items-center">
              <select
                value={person}
                onChange={(e) => setPerson(e.target.value)}
                title="Lọc theo người vật (người gửi / người nhận / đối tượng)"
                className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-2 pr-6 text-[11px] appearance-none cursor-pointer focus:outline-none focus:border-[#4a7dff] max-w-40"
              >
                <option value="all">Người vật: Tất cả</option>
                {persons.map((pr) => (
                  <option key={pr} value={pr}>{pr}</option>
                ))}
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1.5 text-slate-300" />
            </div>

            {/* Bộ lọc QR */}
            <div className="relative inline-flex items-center">
              <select
                value={qrOnly}
                onChange={(e) => setQrOnly(e.target.value)}
                title="Lọc bản ghi có mã QR"
                className="h-6 rounded bg-[#0c223c] text-white border border-white/20 px-2 pr-6 text-[11px] appearance-none cursor-pointer focus:outline-none focus:border-[#4a7dff]"
              >
                <option value="all">QR: Tất cả</option>
                <option value="qr">QR: Có mã QR</option>
              </select>
              <ChevronDown size={11} className="pointer-events-none absolute right-1.5 text-slate-300" />
            </div>

            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded bg-white/5 text-slate-300 text-[11px] border border-white/10">
              {t('Tags: All')}
            </span>
          </div>

          {/* Ô tìm kiếm Search + GO */}
          <form
            onSubmit={(e) => {
              e.preventDefault()
              setActiveSearch(searchQuery)
            }}
            className="flex items-center gap-1 ml-2"
          >
            <div className="relative flex items-center">
              <input
                type="text"
                placeholder={t('Type a search term...')}
                value={searchQuery}
                onChange={(e) => setSearchQuery(e.target.value)}
                className="h-6 w-44 lg:w-60 rounded bg-white text-slate-900 placeholder:text-slate-400 px-2 text-xs border border-slate-300 focus:outline-none focus:ring-1 focus:ring-[#2f6fed]"
              />
              {searchQuery && (
                <button
                  type="button"
                  onClick={() => {
                    setSearchQuery('')
                    setActiveSearch('')
                  }}
                  className="absolute right-1 text-slate-400 hover:text-slate-700 cursor-pointer"
                >
                  <X size={12} />
                </button>
              )}
            </div>
            <button
              type="submit"
              className="h-6 px-2.5 rounded bg-[#2f6fed] hover:bg-[#2458c9] text-white text-[11px] font-bold tracking-wider cursor-pointer"
            >
              {t('GO')}
            </button>
          </form>
        </div>
      </header>

      {/* Thông báo lỗi nếu có */}
      {err && (
        <div className="bg-red-50 text-red-600 px-4 py-1 text-xs border-b border-red-200">
          Lỗi: {err}
        </div>
      )}

      {/* =========================================================================
          ROW 3: MAGNET AXIOM 3-PANE WORKSPACE
          ========================================================================= */}
      <div className="flex flex-1 min-h-0 overflow-hidden relative">
        {/* =====================================================================
            CỘT 1 (TRÁI): ARTIFACTS CATEGORIES TREE
            ===================================================================== */}
        <aside className="w-52 lg:w-56 shrink-0 bg-white border-r border-[#d3dbe3] flex flex-col overflow-hidden">
          {/* Header Cột trái */}
          <div className="h-9 px-3 bg-[#e8eef3] border-b border-[#d3dbe3] flex items-center justify-between text-xs font-semibold text-[#0f2a4a]">
            <span className="flex items-center gap-1.5">
              <Layers size={14} className="text-[#2f6fed]" />
              <span>Artifacts Categories</span>
            </span>
            <span className="text-[11px] px-1.5 py-0.2 rounded bg-slate-200 text-slate-700 font-medium">
              {filteredArtifacts.length}
            </span>
          </div>

          {/* Danh sách các cây danh mục */}
          <div className="flex-1 overflow-y-auto p-1.5 space-y-1 text-xs">
            {/* Mục: Toàn bộ chứng cứ */}
            <button
              type="button"
              onClick={() => {
                setSelectedCategory('all')
                setSelectedSubCategory('all')
              }}
              className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors cursor-pointer ${
                selectedCategory === 'all' && selectedSubCategory === 'all'
                  ? 'bg-[#0078d4] text-white font-medium shadow-xs'
                  : 'text-slate-700 hover:bg-slate-100'
              }`}
            >
              <span className="flex items-center gap-2">
                <Shield size={14} />
                <span>{t('All evidence')}</span>
              </span>
              <span
                className={`text-[11px] px-1.5 rounded-full font-bold ${
                  selectedCategory === 'all' && selectedSubCategory === 'all'
                    ? 'bg-white/20 text-white'
                    : 'bg-slate-100 text-slate-600'
                }`}
              >
                {categoryCounts.c.all || 0}
              </span>
            </button>

            {/* Mục: CHAT & MESSAGES */}
            <div className="pt-0.5">
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('chat')
                  setSelectedSubCategory('all')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors font-medium cursor-pointer ${
                  selectedCategory === 'chat' && selectedSubCategory === 'all'
                    ? 'bg-[#0078d4] text-white shadow-xs'
                    : 'text-[#0f2a4a] hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <MessageSquare
                    size={14}
                    className={
                      selectedCategory === 'chat' && selectedSubCategory === 'all'
                        ? 'text-white'
                        : 'text-[#2f6fed]'
                    }
                  />
                  <span className="font-bold">CHAT & MESSAGES</span>
                </span>
                <span
                  className={`text-[11px] px-1.5 rounded-full font-bold ${
                    selectedCategory === 'chat' && selectedSubCategory === 'all'
                      ? 'bg-white/20 text-white'
                      : 'bg-blue-50 text-blue-700'
                  }`}
                >
                  {categoryCounts.c.chat || 0}
                </span>
              </button>

              {/* Subcategories của CHAT */}
              <div className="pl-5 pr-1 py-0.5 space-y-0.5">
                {['SMS / MMS', 'Zalo / OTT chat'].map((sub) => {
                  const cnt = categoryCounts.sub[sub] || 0
                  const isSubActive = selectedCategory === 'chat' && selectedSubCategory === sub
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => {
                        setSelectedCategory('chat')
                        setSelectedSubCategory(sub)
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11.5px] transition-colors cursor-pointer ${
                        isSubActive ? 'bg-[#0078d4] text-white font-medium' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>{t(sub)}</span>
                      <span className={`text-[10px] ${isSubActive ? 'text-white' : 'text-slate-400'}`}>
                        {cnt}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Mục: CALL LOGS */}
            <div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('call')
                  setSelectedSubCategory('all')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors font-medium cursor-pointer ${
                  selectedCategory === 'call' && selectedSubCategory === 'all'
                    ? 'bg-[#0078d4] text-white shadow-xs'
                    : 'text-[#0f2a4a] hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <PhoneCall
                    size={14}
                    className={
                      selectedCategory === 'call' && selectedSubCategory === 'all'
                        ? 'text-white'
                        : 'text-emerald-600'
                    }
                  />
                  <span className="font-bold">CALL LOGS</span>
                </span>
                <span
                  className={`text-[11px] px-1.5 rounded-full font-bold ${
                    selectedCategory === 'call' && selectedSubCategory === 'all'
                      ? 'bg-white/20 text-white'
                      : 'bg-emerald-50 text-emerald-700'
                  }`}
                >
                  {categoryCounts.c.call || 0}
                </span>
              </button>

              <div className="pl-5 pr-1 py-0.5 space-y-0.5">
                {['Outgoing call', 'Incoming call'].map((sub) => {
                  const cnt = categoryCounts.sub[sub] || 0
                  const isSubActive = selectedCategory === 'call' && selectedSubCategory === sub
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => {
                        setSelectedCategory('call')
                        setSelectedSubCategory(sub)
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11.5px] transition-colors cursor-pointer ${
                        isSubActive ? 'bg-[#0078d4] text-white font-medium' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>{t(sub)}</span>
                      <span className={`text-[10px] ${isSubActive ? 'text-white' : 'text-slate-400'}`}>
                        {cnt}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Mục: CONTACTS */}
            <div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('contact')
                  setSelectedSubCategory('all')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors font-medium cursor-pointer ${
                  selectedCategory === 'contact' ? 'bg-[#0078d4] text-white shadow-xs' : 'text-[#0f2a4a] hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <Users
                    size={14}
                    className={selectedCategory === 'contact' ? 'text-white' : 'text-purple-600'}
                  />
                  <span className="font-bold">CONTACTS</span>
                </span>
                <span
                  className={`text-[11px] px-1.5 rounded-full font-bold ${
                    selectedCategory === 'contact' ? 'bg-white/20 text-white' : 'bg-purple-50 text-purple-700'
                  }`}
                >
                  {categoryCounts.c.contact || 0}
                </span>
              </button>
            </div>

            {/* Mục: MEDIA & PICTURES */}
            <div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('media')
                  setSelectedSubCategory('all')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors font-medium cursor-pointer ${
                  selectedCategory === 'media' && selectedSubCategory === 'all'
                    ? 'bg-[#0078d4] text-white shadow-xs'
                    : 'text-[#0f2a4a] hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <ImageIcon
                    size={14}
                    className={
                      selectedCategory === 'media' && selectedSubCategory === 'all'
                        ? 'text-white'
                        : 'text-amber-600'
                    }
                  />
                  <span className="font-bold">MEDIA & PICTURES</span>
                </span>
                <span
                  className={`text-[11px] px-1.5 rounded-full font-bold ${
                    selectedCategory === 'media' && selectedSubCategory === 'all'
                      ? 'bg-white/20 text-white'
                      : 'bg-amber-50 text-amber-700'
                  }`}
                >
                  {categoryCounts.c.media || 0}
                </span>
              </button>

              <div className="pl-5 pr-1 py-0.5 space-y-0.5">
                {['Camera log', 'Photos / Video'].map((sub) => {
                  const cnt = categoryCounts.sub[sub] || 0
                  const isSubActive = selectedCategory === 'media' && selectedSubCategory === sub
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => {
                        setSelectedCategory('media')
                        setSelectedSubCategory(sub)
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11.5px] transition-colors cursor-pointer ${
                        isSubActive ? 'bg-[#0078d4] text-white font-medium' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>{t(sub)}</span>
                      <span className={`text-[10px] ${isSubActive ? 'text-white' : 'text-slate-400'}`}>
                        {cnt}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>

            {/* Mục: DOCUMENTS & TEXT */}
            <div>
              <button
                type="button"
                onClick={() => {
                  setSelectedCategory('document')
                  setSelectedSubCategory('all')
                }}
                className={`w-full flex items-center justify-between px-2.5 py-1.5 rounded text-left transition-colors font-medium cursor-pointer ${
                  selectedCategory === 'document' && selectedSubCategory === 'all'
                    ? 'bg-[#0078d4] text-white shadow-xs'
                    : 'text-[#0f2a4a] hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-2">
                  <FileText
                    size={14}
                    className={
                      selectedCategory === 'document' && selectedSubCategory === 'all'
                        ? 'text-white'
                        : 'text-cyan-600'
                    }
                  />
                  <span className="font-bold">DOCUMENTS & TEXT</span>
                </span>
                <span
                  className={`text-[11px] px-1.5 rounded-full font-bold ${
                    selectedCategory === 'document' && selectedSubCategory === 'all'
                      ? 'bg-white/20 text-white'
                      : 'bg-cyan-50 text-cyan-700'
                  }`}
                >
                  {categoryCounts.c.document || 0}
                </span>
              </button>

              <div className="pl-5 pr-1 py-0.5 space-y-0.5">
                {['Transaction log', 'Documents & Notes'].map((sub) => {
                  const cnt = categoryCounts.sub[sub] || 0
                  const isSubActive = selectedCategory === 'document' && selectedSubCategory === sub
                  return (
                    <button
                      key={sub}
                      type="button"
                      onClick={() => {
                        setSelectedCategory('document')
                        setSelectedSubCategory(sub)
                      }}
                      className={`w-full flex items-center justify-between px-2 py-1 rounded text-left text-[11.5px] transition-colors cursor-pointer ${
                        isSubActive ? 'bg-[#0078d4] text-white font-medium' : 'text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      <span>{t(sub)}</span>
                      <span className={`text-[10px] ${isSubActive ? 'text-white' : 'text-slate-400'}`}>
                        {cnt}
                      </span>
                    </button>
                  )
                })}
              </div>
            </div>
          </div>

          {/* Footer Cột trái */}
          <div className="h-8 px-3 bg-[#f7f9fa] border-t border-[#d3dbe3] flex items-center justify-between text-[11px] text-slate-500">
            <span>{t('Devices')}: {activeDevice || t('All devices')}</span>
            <span className="text-[#2f6fed] font-semibold">{files.length} tệp</span>
          </div>
        </aside>

        {/* =====================================================================
            CỘT 2 (GIỮA): EVIDENCE GRID / CONVERSATION VIEW
            ===================================================================== */}
        <section className="flex-1 flex flex-col min-w-0 bg-white overflow-hidden border-r border-[#d3dbe3]">
          {/* Header Cột giữa */}
          <div className="h-9 px-3 bg-[#e8eef3] border-b border-[#d3dbe3] flex items-center justify-between text-xs">
            <div className="flex items-center gap-2">
              <span className="font-bold text-[#0f2a4a]">Evidence</span>
              <span className="text-slate-500">({filteredArtifacts.length})</span>
              {activeSearch && (
                <span className="px-2 py-0.5 rounded bg-amber-100 text-amber-800 text-[11px] font-medium">
                  Lọc: "{activeSearch}"
                </span>
              )}
            </div>

            {/* Một nút chuyển vòng chế độ xem: Column -> Grid -> Conversation -> Column */}
            <button
              type="button"
              onClick={() => setViewMode(nextView)}
              title={`Bấm để chuyển sang ${VIEW_LABEL[nextView]}`}
              className="h-6 px-2.5 rounded text-[11px] font-medium transition-colors cursor-pointer flex items-center gap-1 bg-[#0078d4] hover:bg-[#006abc] text-white shadow-xs"
            >
              {viewMode === 'grid' ? <LayoutGrid size={12} /> : viewMode === 'conversation' ? <MessageSquare size={12} /> : <Rows3 size={12} />}
              <span>{VIEW_LABEL[viewMode]}</span>
              <Repeat size={11} className="opacity-70" />
            </button>
          </div>

          {/* Vùng hiển thị bảng dữ liệu chứng cứ */}
          <div className="flex-1 overflow-auto">
            {loading ? (
              <div className="p-12 text-center text-xs text-slate-400">{t('Loading case data...')}</div>
            ) : filteredArtifacts.length === 0 ? (
              <div className="p-12 text-center text-slate-400 text-xs">
                Không tìm thấy bản ghi chứng cứ nào phù hợp với bộ lọc hiện tại.
              </div>
            ) : viewMode === 'grid' ? (
              gridItems.length === 0 ? (
                <div className="p-12 text-center text-slate-400 text-xs">Không có ảnh/video nào trong bộ lọc hiện tại.</div>
              ) : (
                <div className="grid grid-cols-[repeat(auto-fill,minmax(110px,1fr))] gap-0.5 p-0.5">
                  {gridItems.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      title={`${item.displayName} • ${item.timestamp}`}
                      onClick={() => { setSelectedArtifactId(item.id); setLightbox(true) }}
                      className={`relative aspect-square overflow-hidden bg-slate-200 cursor-pointer ${
                        selectedArtifact?.id === item.id ? 'outline-2 -outline-offset-2 outline-[#0078d4]' : ''
                      }`}
                    >
                      {item.raw?.thumb_url ? (
                        <img src={item.raw.thumb_url} alt={item.displayName} loading="lazy" className="h-full w-full object-cover" />
                      ) : (
                        <span className="flex h-full items-center justify-center text-slate-400"><ImageIcon size={22} /></span>
                      )}
                      {item.raw?.kind === 'video' && <Play size={14} className="absolute bottom-1 right-1 fill-white text-white drop-shadow" />}
                    </button>
                  ))}
                </div>
              )
            ) : viewMode === 'conversation' ? (
              /* Conversation View */
              <div className="flex h-full">
                {/* Danh sách hội thoại */}
                <div className="w-64 shrink-0 border-r border-[#d3dbe3] bg-[#fbfcfd] overflow-y-auto p-1.5 space-y-1">
                  <div className="px-2 py-1 text-[10.5px] font-bold text-slate-400 uppercase tracking-wider">
                    HỘI THOÁI & LIÊN LẠC
                  </div>
                  {conversationThreads.map((th) => {
                    const isThreadActive =
                      (activeThreadId || selectedArtifact?.threadId) === th.threadId
                    return (
                      <button
                        key={th.threadId}
                        type="button"
                        onClick={() => {
                          setActiveThreadId(th.threadId)
                          const firstOfThread = artifacts.find(
                            (a) => a.threadId === th.threadId || a.chatId === th.threadId
                          )
                          if (firstOfThread) setSelectedArtifactId(firstOfThread.id)
                        }}
                        className={`w-full text-left p-2 rounded border transition-all cursor-pointer flex items-start gap-2 ${
                          isThreadActive
                            ? 'bg-[#e5f1fb] border-[#0078d4] text-[#0078d4] shadow-xs'
                            : 'bg-white border-slate-200 hover:border-slate-300 text-slate-700'
                        }`}
                      >
                        <div
                          className={`h-7 w-7 rounded-full flex items-center justify-center shrink-0 ${
                            isThreadActive ? 'bg-[#0078d4] text-white' : 'bg-slate-200 text-slate-600'
                          }`}
                        >
                          <User size={13} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between">
                            <span className="font-bold text-[11px] truncate max-w-36">
                              {th.title}
                            </span>
                            <span className="text-[10px] text-slate-400">{th.count}</span>
                          </div>
                          <p className="text-[10px] text-slate-500 truncate mt-0.5">{th.lastMsg}</p>
                        </div>
                      </button>
                    )
                  })}
                </div>

                {/* Luồng tin nhắn trong hội thoại */}
                <div className="flex-1 overflow-y-auto p-4 space-y-3 bg-[#fafbfc]">
                  <div className="border-b border-slate-200 pb-2 mb-3">
                    <h3 className="font-bold text-slate-800 text-xs">
                      Conversation: {activeThreadId || selectedArtifact?.threadId || 'General'}
                    </h3>
                  </div>

                  {(selectedArtifact?.threadMessages || [
                    {
                      id: selectedArtifact?.id || '0',
                      author: selectedArtifact?.author || '',
                      timestamp: selectedArtifact?.timestamp || '',
                      text: selectedArtifact?.content || '',
                      isOutgoing: false,
                    },
                  ]).map((msg) => (
                    <div
                      key={msg.id}
                      className={`flex flex-col ${msg.isOutgoing ? 'items-end' : 'items-start'}`}
                    >
                      <span className="text-[10px] text-slate-400 mb-0.5 px-1">
                        {msg.author} &bull; {msg.timestamp}
                      </span>
                      <div
                        className={`max-w-[80%] rounded-xl px-3 py-2 text-xs leading-relaxed shadow-2xs ${
                          msg.isOutgoing
                            ? 'bg-[#0078d4] text-white rounded-tr-none'
                            : 'bg-white text-slate-800 rounded-tl-none border border-slate-200'
                        }`}
                      >
                        {msg.text}
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            ) : (
              /* Column View (Bảng chứng cứ) */
              <table className="w-full text-left text-xs border-collapse">
                <thead className="sticky top-0 bg-[#f3f6f9] border-b border-slate-300 text-slate-600 font-semibold text-[11px] select-none z-10">
                  <tr>
                    <th className="py-1.5 px-2.5 border-r border-slate-200 w-12 text-center">#</th>
                    <th className="py-1.5 px-2.5 border-r border-slate-200 min-w-32">{t('Chat ID / Source')}</th>
                    <th className="py-1.5 px-2.5 border-r border-slate-200 min-w-28">{t('Author / Sender')}</th>
                    <th className="py-1.5 px-2.5 border-r border-slate-200 min-w-28">{t('Recipient / Receiver')}</th>
                    <th className="py-1.5 px-2.5 border-r border-slate-200 min-w-36">Message Sent Date/Time</th>
                    <th className="py-1.5 px-3 min-w-60">{t('Message / Extracted text')}</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-150">
                  {filteredArtifacts.map((item, idx) => {
                    const isSelected = selectedArtifact?.id === item.id
                    return (
                      <tr
                        key={item.id}
                        onClick={() => setSelectedArtifactId(item.id)}
                        className={`cursor-pointer transition-colors ${
                          isSelected
                            ? 'bg-[#0078d4] text-white hover:bg-[#0078d4]'
                            : idx % 2 === 1
                            ? 'bg-slate-50/60 hover:bg-blue-50/60'
                            : 'bg-white hover:bg-blue-50/60'
                        }`}
                      >
                        <td
                          className={`py-1.5 px-2.5 text-center text-[11px] border-r ${
                            isSelected ? 'border-blue-500/40 text-blue-100' : 'border-slate-200/70 text-slate-400'
                          }`}
                        >
                          {idx + 1}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 font-medium border-r truncate max-w-40 ${
                            isSelected ? 'border-blue-500/40 text-white' : 'border-slate-200/70 text-[#0f2a4a]'
                          }`}
                          title={item.chatId || item.displayName}
                        >
                          {item.chatId || item.displayName}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 border-r truncate max-w-28 ${
                            isSelected ? 'border-blue-500/40 text-blue-100' : 'border-slate-200/70 text-slate-700'
                          }`}
                          title={item.author}
                        >
                          {item.author || '-'}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 border-r truncate max-w-28 ${
                            isSelected ? 'border-blue-500/40 text-blue-100' : 'border-slate-200/70 text-slate-700'
                          }`}
                          title={item.recipient}
                        >
                          {item.recipient || '-'}
                        </td>
                        <td
                          className={`py-1.5 px-2.5 border-r whitespace-nowrap text-[11.5px] ${
                            isSelected ? 'border-blue-500/40 text-blue-100' : 'border-slate-200/70 text-slate-500'
                          }`}
                        >
                          {item.timestamp || '-'}
                        </td>
                        <td
                          className={`py-1.5 px-3 truncate max-w-md ${
                            isSelected ? 'text-white' : 'text-slate-700'
                          }`}
                          title={item.content}
                        >
                          {item.content || '-'}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>

          {/* Footer Cột giữa */}
          <div className="h-8 px-3 bg-[#f7f9fa] border-t border-[#d3dbe3] flex items-center justify-between text-[11px] text-slate-500">
            <span>{t('Showing')} {filteredArtifacts.length} {t('records')}</span>
            <span className="text-slate-400 font-mono">Time zone: GMT+7 (Hà Nội, Băng Cốc)</span>
          </div>
        </section>

        {/* =====================================================================
            CỘT 3 (PHẢI): ARTIFACT PREVIEW & DETAILS
            ===================================================================== */}
        <aside className="w-80 lg:w-96 shrink-0 bg-[#fbfcfd] flex flex-col overflow-hidden border-r border-[#d3dbe3]">
          {/* Header Cột phải */}
          <div className="h-9 px-3 bg-[#e8eef3] border-b border-[#d3dbe3] flex items-center justify-between text-xs">
            <span
              className="font-bold text-[#0f2a4a] truncate max-w-56"
              title={selectedArtifact?.displayName}
            >
              {selectedArtifact?.displayName || 'Artifact Preview'}
            </span>
            <button
              type="button"
              onClick={() => setShowTagsDrawer(!showTagsDrawer)}
              className="px-2 py-0.5 rounded bg-white text-slate-600 border border-slate-300 text-[11px] font-medium hover:bg-slate-50 cursor-pointer"
            >
              Gắn thẻ
            </button>
            {selectedArtifact?.raw?.id != null && (
              <button
                type="button"
                onClick={() => {
                  const fid = selectedArtifact!.raw!.id
                  if (!window.confirm('Xoá tài liệu này khỏi vụ án?')) return
                  api
                    .deleteFile(name, fid)
                    .then(() => loadData())
                    .catch(() => {})
                }}
                className="ml-1 px-2 py-0.5 rounded bg-white text-red-600 border border-red-200 text-[11px] font-medium hover:bg-red-50 cursor-pointer"
              >
                <Trash2 size={11} className="inline mr-0.5" /> Xoá
              </button>
            )}
          </div>

          {/* Nội dung Cột phải */}
          <div className="flex-1 flex flex-col min-h-0 overflow-y-auto">
            {selectedArtifact ? (
              <>
                {/* 1. KHUNG PREVIEW */}
                <div className="border-b border-[#d3dbe3] bg-white p-3 flex flex-col shrink-0">
                  <div className="flex items-center justify-between pb-2 mb-2 border-b border-slate-150 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    <span>PREVIEW</span>
                    <span className="text-[10px] text-[#2f6fed] font-semibold">
                      {selectedArtifact.subCategory}
                    </span>
                  </div>

                  {/* Hiển thị Bong bóng Chat */}
                  {selectedArtifact.category === 'chat' ? (
                    <div className="space-y-3 py-1 max-h-64 overflow-y-auto pr-1">
                      {selectedArtifact.threadMessages && selectedArtifact.threadMessages.length > 0 ? (
                        selectedArtifact.threadMessages.map((m, i) => (
                          <div
                            key={i}
                            className={`flex flex-col ${m.isOutgoing ? 'items-end' : 'items-start'}`}
                          >
                            <span className="text-[10px] text-slate-400 mb-0.5 px-1">
                              {m.author} &bull; {m.timestamp}
                            </span>
                            <div
                              className={`max-w-[85%] rounded-2xl px-3 py-2 text-xs leading-relaxed shadow-2xs ${
                                m.isOutgoing
                                  ? 'bg-[#0078d4] text-white rounded-tr-xs'
                                  : 'bg-[#f0f4f8] text-slate-800 rounded-tl-xs border border-slate-200/80'
                              }`}
                            >
                              {m.text}
                            </div>
                          </div>
                        ))
                      ) : (
                        <div className="flex flex-col items-start">
                          <span className="text-[10px] text-slate-400 mb-0.5 px-1">
                            {selectedArtifact.author} &bull; {selectedArtifact.timestamp}
                          </span>
                          <div className="max-w-[90%] rounded-2xl rounded-tl-xs bg-[#f0f4f8] text-slate-800 px-3 py-2 text-xs border border-slate-200">
                            {selectedArtifact.content}
                          </div>
                        </div>
                      )}
                    </div>
                  ) : selectedArtifact.raw?.thumb_url ? (
                    <div className="py-2 flex flex-col items-center">
                      <img
                        src={selectedArtifact.raw.thumb_url}
                        alt=""
                        className="max-h-56 rounded border border-slate-200 object-contain shadow-xs"
                      />
                      <a
                        href={selectedArtifact.raw.file_url}
                        target="_blank"
                        rel="noreferrer"
                        className="mt-2 text-xs text-[#0078d4] hover:underline"
                      >
                        Mở tệp ảnh gốc
                      </a>
                    </div>
                  ) : (
                    <div className="py-1">
                      <p className="text-xs text-slate-700 bg-slate-50 p-2.5 rounded border border-slate-200 font-mono leading-relaxed max-h-48 overflow-y-auto whitespace-pre-wrap">
                        {selectedArtifact.content || 'No text preview available.'}
                      </p>
                    </div>
                  )}
                </div>

                {/* 2. BẢNG THUỘC TÍNH CHI TIẾT */}
                <div className="p-3 bg-[#fbfcfd] flex-1">
                  <div className="flex items-center justify-between pb-1.5 mb-2 border-b border-slate-200 text-[11px] font-bold text-slate-500 uppercase tracking-wider">
                    <span>DETAILS & ARTIFACT INFORMATION</span>
                  </div>

                  <dl className="divide-y divide-slate-200/70 text-xs">
                    {Object.entries(selectedArtifact.metadata).map(([key, val]) => {
                      if (!val) return null
                      return (
                        <div key={key} className="py-1.5 flex flex-col gap-0.5">
                          <dt className="text-[11px] font-semibold text-slate-400 uppercase tracking-wider">
                            {t(key)}
                          </dt>
                          <dd className="text-slate-800 break-all select-text font-mono text-[11.5px]">
                            {String(val)}
                          </dd>
                        </div>
                      )
                    })}
                  </dl>

                  {/* Nút tải về tệp gốc */}
                  {selectedArtifact.raw?.file_url && (
                    <div className="mt-4 pt-3 border-t border-slate-200">
                      <a
                        href={selectedArtifact.raw.file_url}
                        target="_blank"
                        rel="noreferrer"
                        className="inline-flex items-center justify-center w-full gap-1.5 rounded bg-white hover:bg-slate-50 border border-slate-300 py-1.5 text-xs font-medium text-slate-700 shadow-2xs transition-colors"
                      >
                        <Download size={13} />
                        <span>{t('Download original')}</span>
                      </a>
                    </div>
                  )}
                </div>
              </>
            ) : (
              <div className="p-8 text-center text-xs text-slate-400">
                Chọn 1 bản ghi chứng cứ để xem chi tiết
              </div>
            )}
          </div>
        </aside>

        {/* =====================================================================
            CỘT 4 (MÉP PHẢI): DẢI TAB DỌC "TAGS, COMMENTS & PROFILES"
            ===================================================================== */}
        <div
          onClick={() => setShowTagsDrawer(!showTagsDrawer)}
          title="Mở bảng Gắn thẻ & Ghi chú nghiệp vụ"
          className="w-7 shrink-0 bg-[#e3e9ef] hover:bg-[#d5dfe8] border-l border-[#ccd5de] flex flex-col items-center py-4 select-none cursor-pointer transition-colors"
        >
          <div className="rotate-90 origin-center whitespace-nowrap text-[10px] font-bold tracking-widest text-slate-500 uppercase mt-16 flex items-center gap-1.5">
            <Tag size={11} />
            <span>TAGS, COMMENTS & PROFILES</span>
          </div>
        </div>

        {/* SLIDE-OUT DRAWER KHI BẤM "TAGS, COMMENTS & PROFILES" */}
        {showTagsDrawer && (
          <aside className="absolute right-7 top-0 bottom-0 w-80 bg-white border-l border-[#d5dce3] shadow-2xl z-40 flex flex-col">
            <div className="h-9 px-3 bg-[#0f2a4a] text-white flex items-center justify-between text-xs font-semibold">
              <span className="flex items-center gap-1.5">
                <Tag size={13} className="text-[#00bcd4]" />
                <span>TAGS, COMMENTS & PROFILES</span>
              </span>
              <button
                type="button"
                onClick={() => setShowTagsDrawer(false)}
                className="text-slate-400 hover:text-white"
              >
                <X size={14} />
              </button>
            </div>

            <div className="flex-1 overflow-y-auto p-3 space-y-4 text-xs">
              {/* Thẻ điều tra */}
              <div>
                <h4 className="font-bold text-slate-700 text-xs mb-2 flex items-center gap-1.5">
                  <Bookmark size={13} className="text-[#0078d4]" />
                  <span>{t('Forensic Tags')}</span>
                </h4>
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {[
                    'Quan trọng',
                    'Ma túy',
                    'Nghi phạm chính',
                    'Tài chính',
                    'Địa điểm',
                    'Xóa dấu vết',
                  ].map((tg) => {
                    const activeTags = itemTags[selectedArtifact?.id || 'default'] || []
                    const hasTag = activeTags.includes(tg)
                    return (
                      <button
                        key={tg}
                        type="button"
                        onClick={() => {
                          const id = selectedArtifact?.id || 'default'
                          const current = itemTags[id] || []
                          setItemTags({
                            ...itemTags,
                            [id]: hasTag ? current.filter((t) => t !== tg) : [...current, tg],
                          })
                        }}
                        className={`px-2 py-1 rounded text-[11px] font-medium border transition-colors cursor-pointer ${
                          hasTag
                            ? 'bg-[#0078d4] text-white border-[#0078d4]'
                            : 'bg-slate-50 text-slate-600 border-slate-300 hover:bg-slate-100'
                        }`}
                      >
                        {hasTag ? '✓ ' : '+ '}
                        {tg}
                      </button>
                    )
                  })}
                </div>

                <div className="flex items-center gap-1 mt-1">
                  <input
                    type="text"
                    placeholder={t('Enter new tag name...')}
                    value={newTagInput}
                    onChange={(e) => setNewTagInput(e.target.value)}
                    className="flex-1 h-6 px-2 text-[11px] border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-[#0078d4]"
                  />
                  <button
                    type="button"
                    onClick={() => {
                      if (!newTagInput.trim()) return
                      const id = selectedArtifact?.id || 'default'
                      const current = itemTags[id] || []
                      setItemTags({ ...itemTags, [id]: [...current, newTagInput.trim()] })
                      setNewTagInput('')
                    }}
                    className="h-6 px-2 bg-slate-700 hover:bg-slate-800 text-white text-[11px] rounded cursor-pointer"
                  >
                    Thêm
                  </button>
                </div>
              </div>

              {/* Ghi chú điều tra */}
              <div className="pt-2 border-t border-slate-200">
                <h4 className="font-bold text-slate-700 text-xs mb-1.5 flex items-center gap-1.5">
                  <MessageCircle size={13} className="text-emerald-600" />
                  <span>{t('Investigator notes')}</span>
                </h4>
                <textarea
                  rows={4}
                  placeholder={t('Note on behavior or evidence link...')}
                  value={
                    currentNoteInput !== ''
                      ? currentNoteInput
                      : itemNotes[selectedArtifact?.id || 'default'] || ''
                  }
                  onChange={(e) => setCurrentNoteInput(e.target.value)}
                  className="w-full p-2 text-[11.5px] border border-slate-300 rounded focus:outline-none focus:ring-1 focus:ring-[#0078d4] text-slate-800 leading-relaxed"
                />
                <button
                  type="button"
                  onClick={() => {
                    const id = selectedArtifact?.id || 'default'
                    setItemNotes({ ...itemNotes, [id]: currentNoteInput })
                    setCurrentNoteInput('')
                  }}
                  className="mt-1.5 w-full py-1 bg-[#2f6fed] hover:bg-[#2458c9] text-white rounded text-[11px] font-medium transition-colors cursor-pointer"
                >
                  Lưu ghi chú chứng cứ
                </button>
              </div>

              {/* Hồ sơ liên đới */}
              <div className="pt-2 border-t border-slate-200">
                <h4 className="font-bold text-slate-700 text-xs mb-2 flex items-center gap-1.5">
                  <User size={13} className="text-purple-600" />
                  <span>{t('Related profiles (Profiles)')}</span>
                </h4>
                <div className="space-y-1.5">
                  <div className="p-2 rounded bg-slate-50 border border-slate-200 flex items-center justify-between">
                    <div>
                      <p className="font-bold text-slate-800 text-[11.5px]">Lê Văn C (Đối tượng chính)</p>
                      <p className="text-[10.5px] text-slate-500">SĐT: 0901234567 · Laptop Dell</p>
                    </div>
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-100 text-blue-700 font-bold">
                      Đã gắn
                    </span>
                  </div>
                </div>
              </div>
            </div>
          </aside>
        )}
      </div>

      {/* =========================================================================
          MODALS QUẢN LÝ & TÁC VỤ
          ========================================================================= */}
      {openCollectModal && (
        <CollectModal
          name={name}
          onClose={() => {
            setOpenCollectModal(false)
            loadData()
          }}
        />
      )}

      {openUploadModal && (
        <UploadModal
          name={name}
          devices={devs?.items || []}
          onClose={() => {
            setOpenUploadModal(false)
            loadData()
          }}
        />
      )}

      {openPackageModal && (
        <PackageModal name={name} onClose={() => setOpenPackageModal(false)} />
      )}

      {lbItem?.raw && (
        <div role="dialog" aria-modal="true" className="fixed inset-0 z-50 flex bg-black/95 text-white" onClick={() => setLightbox(false)}>
          <div className="relative flex flex-1 min-w-0 items-center justify-center p-12">
            {lbItem.raw.kind === 'video' ? (
              <video key={lbItem.id} src={lbItem.raw.file_url} poster={lbItem.raw.thumb_url ?? undefined} controls autoPlay className="max-h-full max-w-full" onClick={(e) => e.stopPropagation()} />
            ) : lbItem.raw.kind === 'audio' ? (
              <audio key={lbItem.id} src={lbItem.raw.file_url} controls autoPlay onClick={(e) => e.stopPropagation()} />
            ) : (
              <img
                key={lbItem.id}
                src={lbItem.raw.file_url}
                alt={lbItem.displayName}
                // HEIC gốc của iPhone Chrome không hiển thị được -> lùi về ảnh thu nhỏ JPEG
                onError={(e) => { const th = lbItem.raw?.thumb_url; if (th && !e.currentTarget.src.endsWith(th)) e.currentTarget.src = th }}
                className="max-h-full max-w-full object-contain"
                onClick={(e) => e.stopPropagation()}
              />
            )}
            <span className="absolute top-3 left-4 text-xs text-slate-300">{li + 1} / {gridItems.length}</span>
            <button type="button" aria-label="Đóng" onClick={() => setLightbox(false)} className="absolute top-2 right-3 rounded-full p-1.5 hover:bg-white/15 cursor-pointer"><X size={20} /></button>
            {gridItems.length > 1 && (
              <>
                <button type="button" aria-label="Ảnh trước" onClick={(e) => { e.stopPropagation(); go(-1) }} className="absolute left-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 hover:bg-white/25 cursor-pointer"><ChevronLeft size={22} /></button>
                <button type="button" aria-label="Ảnh sau" onClick={(e) => { e.stopPropagation(); go(1) }} className="absolute right-2 top-1/2 -translate-y-1/2 rounded-full bg-white/10 p-2 hover:bg-white/25 cursor-pointer"><ChevronRight size={22} /></button>
              </>
            )}
          </div>
          <aside className="hidden md:block w-80 shrink-0 overflow-y-auto bg-[#0f2a4a] p-4 text-xs" onClick={(e) => e.stopPropagation()}>
            <p className="mb-3 break-all text-sm font-semibold">{lbItem.displayName}</p>
            <dl className="space-y-2">
              {Object.entries(lbItem.metadata).map(([k, v]) =>
                v ? (
                  <div key={k}>
                    <dt className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{t(k)}</dt>
                    <dd className="break-all font-mono text-[11.5px] text-slate-100 select-text">{String(v)}</dd>
                  </div>
                ) : null,
              )}
            </dl>
            <a href={lbItem.raw.file_url} target="_blank" rel="noreferrer" className="mt-4 inline-flex items-center gap-1.5 text-[#7aa2ff] hover:underline">
              <Download size={13} />
              <span>{t('Download original')}</span>
            </a>
          </aside>
        </div>
      )}
      {openDeviceMgrModal && (
        <DeviceMgrModal
          name={name}
          devs={devs}
          onClose={() => {
            setOpenDeviceMgrModal(false)
            loadData()
          }}
        />
      )}

      {openCaseMgrModal && (
        <CaseManagerDialog
          name={name}
          caseList={caseList}
          onClose={() => setOpenCaseMgrModal(false)}
          onChanged={(newName?: string) => {
            setOpenCaseMgrModal(false)
            if (newName && newName !== '/') navigate(`/cases/${encodeURIComponent(newName)}`)
            else window.location.reload()
          }}
        />
      )}

      {openGraphModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
          <div className="w-full max-w-5xl rounded-xl bg-white shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
            <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
              <span className="font-bold text-xs flex items-center gap-2 text-[#4a7dff]">
                <Network size={14} />
                Sơ đồ liên kết thực thể & bằng chứng vụ án: {name}
              </span>
              <button
                type="button"
                onClick={() => setOpenGraphModal(false)}
                className="text-slate-400 hover:text-white cursor-pointer"
              >
                <X size={16} />
              </button>
            </div>
            <div className="p-4 flex-1 overflow-auto">
              <GraphView name={name} />
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

// -------------------------------------------------------------
// SƠ ĐỒ QUAN HỆ GRAPH VIEW XUẤT CHO GRAPH.TSX
// -------------------------------------------------------------
export function GraphView({ name, all = false }: { name: string; all?: boolean }) {
  const [g, setG] = useState<Graph | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    setG(null)
    setErr('')
    ;(all ? api.graphAll() : api.graph(name)).then(setG).catch((e: Error) => setErr(e.message))
  }, [name, all])

  const html = useMemo(
    () => g && graphHtml(name, g, location.origin, { src: location.origin + VIS }),
    [g, name]
  )
  const download = async () => {
    if (!g) return
    try {
      const inline = await fetch(VIS).then((r) => {
        if (!r.ok) throw new Error(`HTTP ${r.status}`)
        return r.text()
      })
      const url = URL.createObjectURL(
        new Blob([graphHtml(name, g, location.origin, { inline })], { type: 'text/html' })
      )
      const a = document.createElement('a')
      a.href = url
      a.download = `so-do-quan-he-${name}.html`
      a.click()
      setTimeout(() => URL.revokeObjectURL(url), 1000)
    } catch (e) {
      setErr(`Không tải được thư viện sơ đồ: ${(e as Error).message}`)
    }
  }

  if (err)
    return (
      <p role="alert" className="text-red-500 text-xs">
        {err}
      </p>
    )
  if (!g || !html)
    return (
      <div
        className="h-[60vh] animate-pulse bg-slate-200 rounded-xl flex items-center justify-center text-xs text-slate-500"
        aria-label="Đang tải sơ đồ"
      >
        Đang xây dựng sơ đồ liên kết thực thể...
      </div>
    )
  return (
    <section>
      <div className="mb-3 flex flex-wrap items-center gap-3">
        <p className="text-xs text-slate-600">
          <strong className="text-slate-800">{g.nodes.length}</strong> đối tượng &bull;{' '}
          <strong className="text-slate-800">{g.edges.length}</strong> liên kết. Bấm vào đường nối để
          xem bằng chứng gốc.
        </p>
        <button
          type="button"
          onClick={() => void download()}
          className="ml-auto inline-flex items-center gap-1.5 rounded bg-[#2f6fed] hover:bg-[#2458c9] text-white px-2.5 py-1 text-xs font-medium cursor-pointer transition-colors"
        >
          <Download className="h-3.5 w-3.5" /> Tải file HTML
        </button>
      </div>
      <iframe
        title={`Sơ đồ quan hệ vụ án ${name}`}
        srcDoc={html}
        sandbox="allow-scripts allow-popups allow-popups-to-escape-sandbox"
        className="h-[65vh] w-full rounded border border-slate-300 bg-white"
      />
    </section>
  )
}

// -------------------------------------------------------------
// MODAL THU THẬP DỮ LIỆU ĐIỆN THOẠI USB / ADB
// -------------------------------------------------------------
function CollectModal({ name, onClose }: { name: string; onClose: () => void }) {
  const { t } = useI18n()
  const [type, setType] = useState<DeviceType>('phone')
  const [dn, setDn] = useState('')
  const [usb, setUsb] = useState<{
    type: DeviceType
    name: string
    serial?: string | null
    ios?: boolean
  } | null>(null)
  const [usbList, setUsbList] = useState<
    { type: DeviceType; name: string; serial?: string | null; ios?: boolean }[]
  >([])
  const [pull, setPull] = useState<Awaited<ReturnType<typeof api.pullStatus>> | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    let live = true
    api
      .usb()
      .then((r) => {
        if (!live) return
        const list = (r.items ?? []).map((it: any) => ({
          type: (it.type as DeviceType) || 'phone',
          name: it.name,
          serial: it.serial ?? null,
          ios: it.ios ?? false,
        }))
        setUsbList(list)
        const d = list.find((it: any) => !it.ios) ?? list[0] ?? null
        setUsb(d)
        if (d) {
          setType(d.type)
          setDn(d.name)
        }
      })
      .catch(() => {})
    api
      .pullStatus()
      .then((s) => {
        if (s.running) setPull(s)
      })
      .catch(() => {})
    return () => {
      live = false
    }
  }, [])

  useEffect(() => {
    if (!pull?.running) return
    const id = setInterval(() => {
      api
        .pullStatus()
        .then((s) => {
          setPull(s)
          if (!s.running) clearInterval(id)
        })
        .catch(() => {})
    }, 2000)
    return () => clearInterval(id)
  }, [pull?.running])

  const startPull = async (e: FormEvent) => {
    e.preventDefault()
    const targetName = dn.trim()
    if (!targetName) return setErr('Vui lòng nhập tên thiết bị')
    setBusy(true)
    setErr('')
    try {
      await api.pull(name, targetName, usb?.serial ?? undefined)
      const st = await api.pullStatus()
      setPull(st)
    } catch (e) {
      setErr(e instanceof Error ? e.message : t('Cannot start extraction'))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
          <span className="font-bold text-xs flex items-center gap-2 text-[#4a7dff]">
            <Smartphone size={14} />
            Thu thập dữ liệu USB / ADB
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-4">
          {err && <div className="mb-3 rounded bg-red-50 p-2 text-xs text-red-600">{err}</div>}

          {pull?.running ? (
            <div className="space-y-3 py-2">
              <div className="flex items-center justify-between text-xs">
                <span className="font-medium text-slate-700">{t('Extracting: ')}{pull.device || t('Devices')}</span>
                <span className="font-bold text-[#0078d4]">{pull.pct}%</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-200">
                <div
                  className="h-full bg-[#2f6fed] transition-all duration-300"
                  style={{ width: `${pull.pct}%` }}
                />
              </div>
              <p className="text-xs text-slate-500">
                Đã kéo {pull.files}/{pull.total_files} tệp ({fmtSize(pull.bytes)})
              </p>
            </div>
          ) : (
            <form onSubmit={startPull} className="space-y-3">
              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Loại thiết bị:
                </label>
                <select
                  value={type}
                  onChange={(e) => setType(e.target.value as DeviceType)}
                  className="w-full rounded border border-slate-300 p-2 text-xs"
                >
                  <option value="phone">{t('Android / iOS phone')}</option>
                  <option value="hdd">{t('HDD / USB drive')}</option>
                  <option value="camera">{t('Camera DVR')}</option>
                  <option value="laptop">{t('Laptop / PC')}</option>
                  <option value="other">{t('Other')}</option>
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold text-slate-700 mb-1">
                  Tên thiết bị nhận diện:
                </label>
                <input
                  type="text"
                  value={dn}
                  onChange={(e) => setDn(e.target.value)}
                  placeholder={t('e.g. Samsung Galaxy A52 (0987654321)')}
                  className="w-full rounded border border-slate-300 p-2 text-xs"
                />
              </div>

              {usbList.length > 1 && (
                <div>
                  <label className="block text-xs font-semibold text-slate-700 mb-1">
                    Thiết bị đang cắm:
                  </label>
                  <select
                    value={usb?.name ?? ''}
                    onChange={(e) => {
                      const d = usbList.find((u) => u.name === e.target.value)
                      if (d) { setUsb(d); setType(d.type); setDn(d.name) }
                    }}
                    className="w-full rounded border border-slate-300 p-2 text-xs"
                  >
                    {usbList.map((u) => (
                      <option key={u.name + u.serial} value={u.name}>
                        {u.name} {u.ios ? '(iOS — thu qua backup)' : '(Android — thu qua ADB)'}
                      </option>
                    ))}
                  </select>
                </div>
              )}

              {usb ? (
                <div className={`rounded p-2 text-xs border flex items-center gap-2 ${usb.ios ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-emerald-50 border-emerald-200 text-emerald-800'}`}>
                  <Smartphone size={16} className={usb.ios ? 'text-red-500' : 'text-emerald-600'} />
                  <span>
                    Phát hiện thiết bị kết nối: <strong>{usb.name}</strong> ({usb.serial || 'USB'})
                    {usb.ios && (
                      <span className="block mt-0.5 font-semibold">
                        ✓ iPhone thu được qua iTunes backup: ảnh/video, danh bạ, cuộc gọi, SMS. Dữ liệu app (Zalo/WhatsApp) bị sandbox chặn.
                      </span>
                    )}
                  </span>
                </div>
              ) : (
                <div className="rounded bg-amber-50 border border-amber-200 p-2 text-xs text-amber-800">
                  Chưa phát hiện thiết bị ADB cắm qua USB. Hãy cắm cáp và bật gỡ lỗi USB trên điện thoại.
                </div>
              )}

              <div className="pt-2 flex justify-end gap-2">
                <button
                  type="button"
                  onClick={onClose}
                  className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
                >
                  Đóng
                </button>
                <button
                  type="submit"
                  disabled={busy}
                  className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
                >
                  {busy ? t('Starting...') : t('Start collection')}
                </button>
              </div>
            </form>
          )}
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// MODAL TẢI LÊN TÀI LIỆU CHỨNG CỨ
// -------------------------------------------------------------
function CaseManagerDialog({
  name,
  caseList,
  onClose,
  onChanged,
}: {
  name: string
  caseList: { name: string }[]
  onClose: () => void
  onChanged: (newName?: string) => void
}) {
  const [newCase, setNewCase] = useState('')
  const [newNote, setNewNote] = useState('')
  const [editName, setEditName] = useState(name)
  const [editNote, setEditNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const createCase = async (e: FormEvent) => {
    e.preventDefault()
    if (!newCase.trim()) return
    setBusy(true)
    setErr('')
    try {
      const c = await api.createCase(newCase.trim(), newNote)
      setNewCase('')
      setNewNote('')
      onChanged(c.name)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Lỗi tạo vụ án')
    } finally {
      setBusy(false)
    }
  }
  const renameCase = async (e: FormEvent) => {
    e.preventDefault()
    if (!editName.trim()) return
    setBusy(true)
    setErr('')
    try {
      const c = await api.updateCase(name, editName.trim(), editNote)
      onChanged(c.name)
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Lỗi đổi tên')
    } finally {
      setBusy(false)
    }
  }
  const deleteCase = async () => {
    if (!window.confirm('Xoá vụ án "' + name + '"? Toàn bộ chứng cứ sẽ chuyển vào thùng rác.')) return
    setBusy(true)
    setErr('')
    try {
      await api.deleteCase(name)
      onChanged('/')
    } catch (x) {
      setErr(x instanceof Error ? x.message : 'Lỗi xoá vụ án')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
          <span className="font-bold text-xs flex items-center gap-2 text-[#4a7dff]">
            <Plus size={14} /> Quản lý vụ án / dự án
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>
        <div className="p-4 space-y-4">
          {err && <div className="rounded bg-red-50 p-2 text-xs text-red-600">{err}</div>}

          <form onSubmit={createCase} className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">Tạo vụ án mới:</label>
            <input value={newCase} onChange={(e) => setNewCase(e.target.value)} placeholder="Tên vụ án mới" className="w-full rounded border border-slate-300 p-2 text-xs" />
            <input value={newNote} onChange={(e) => setNewNote(e.target.value)} placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded border border-slate-300 p-2 text-xs" />
            <button type="submit" disabled={busy} className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-1.5 text-xs text-white disabled:opacity-50 cursor-pointer">
              {busy ? '...' : 'Tạo vụ án'}
            </button>
          </form>

          <div className="border-t border-slate-200 pt-3 space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Sửa vụ án hiện tại: <span className="font-normal text-slate-400">{name}</span>
            </label>
            <input value={editName} onChange={(e) => setEditName(e.target.value)} className="w-full rounded border border-slate-300 p-2 text-xs" />
            <input value={editNote} onChange={(e) => setEditNote(e.target.value)} placeholder="Ghi chú (tuỳ chọn)" className="w-full rounded border border-slate-300 p-2 text-xs" />
            <div className="flex gap-2">
              <button type="button" onClick={renameCase} disabled={busy} className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-1.5 text-xs text-white disabled:opacity-50 cursor-pointer">Đổi tên</button>
              <button type="button" onClick={deleteCase} disabled={busy} className="rounded bg-red-600 hover:bg-red-700 px-3 py-1.5 text-xs text-white disabled:opacity-50 cursor-pointer">Xoá vụ án</button>
            </div>
          </div>

          <div className="border-t border-slate-200 pt-2">
            <h4 className="text-xs font-semibold text-slate-700 mb-1">Các vụ án ({caseList.length}):</h4>
            <div className="max-h-40 overflow-y-auto space-y-1">
              {caseList.map((c) => (
                <div key={c.name} className="rounded border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-700">{c.name}</div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}

function UploadModal({
  name,
  devices,
  onClose,
}: {
  name: string
  devices: Device[]
  onClose: () => void
}) {
  const [fileList, setFileList] = useState<FileList | null>(null)
  const [targetDevice, setTargetDevice] = useState(devices[0]?.name || '')
  const [busy, setBusy] = useState(false)
  const { t } = useI18n()
  const [err, setErr] = useState('')

  const handleUpload = async (e: FormEvent) => {
    e.preventDefault()
    if (!fileList || fileList.length === 0) return setErr('Vui lòng chọn ít nhất 1 tệp')
    setBusy(true)
    setErr('')
    try {
      const filesArr = Array.from(fileList)
      await api.upload(filesArr, name, targetDevice || undefined)
      onClose()
    } catch (e) {
      setErr(e instanceof Error ? e.message : 'Tải lên thất bại')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-md rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
          <span className="font-bold text-xs flex items-center gap-2 text-[#00bcd4]">
            <Upload size={14} />
            Tải lên tài liệu chứng cứ
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <form onSubmit={handleUpload} className="p-4 space-y-3">
          {err && <div className="rounded bg-red-50 p-2 text-xs text-red-600">{err}</div>}

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Gán vào thiết bị chứng cứ:
            </label>
            <select
              value={targetDevice}
              onChange={(e) => setTargetDevice(e.target.value)}
              className="w-full rounded border border-slate-300 p-2 text-xs"
            >
              <option value="">{t('Unassigned (Common evidence)')}</option>
              {devices.map((d) => (
                <option key={d.name} value={d.name}>
                  {d.name} ({t(DEVICE_LABELS[d.type])})
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Chọn tệp (PDF, CSV, TXT, Ảnh, Video, DB...):
            </label>
            <input
              type="file"
              multiple
              onChange={(e) => setFileList(e.target.files)}
              className="w-full text-xs text-slate-500 file:mr-2 file:rounded file:border-0 file:bg-slate-100 file:px-2.5 file:py-1.5 file:text-xs file:font-semibold file:text-slate-700 hover:file:bg-slate-200"
            />
          </div>

          <div className="pt-2 flex justify-end gap-2">
            <button
              type="button"
              onClick={onClose}
              className="rounded border border-slate-300 px-3 py-1.5 text-xs font-medium text-slate-700 hover:bg-slate-50 cursor-pointer"
            >
              Đóng
            </button>
            <button
              type="submit"
              disabled={busy}
              className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
            >
              {busy ? t('Uploading...') : t('Upload now')}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// MODAL ĐÓNG GÓI & XUẤT BÁO CÁO CHỨNG CỨ
// -------------------------------------------------------------
function PackageModal({ name, onClose }: { name: string; onClose: () => void }) {
  const { t } = useI18n()
  const [pkgs, setPkgs] = useState<PackageItem[]>([])
  const [busy, setBusy] = useState(false)
  const [desc, setDesc] = useState('')

  const loadPkgs = async () => {
    try {
      const p = await api.images(name)
      setPkgs(p)
    } catch {}
  }

  useEffect(() => {
    loadPkgs()
  }, [name])

  const createPkg = async (e: FormEvent) => {
    e.preventDefault()
    setBusy(true)
    try {
      await api.createPackage(name)
      setDesc('')
      await loadPkgs()
    } catch {} finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
          <span className="font-bold text-xs flex items-center gap-2 text-[#00bcd4]">
            <Archive size={14} />
            Đóng gói & Báo cáo hồ sơ chứng cứ vụ án
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <form onSubmit={createPkg} className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Tạo gói nén chứng cứ điện tử (ZIP có băm SHA-256):
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={t('Packaging note (e.g. Handover to prosecutor round 1)...')}
                value={desc}
                onChange={(e) => setDesc(e.target.value)}
                className="flex-1 rounded border border-slate-300 p-2 text-xs"
              />
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-2 text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
              >
                {busy ? t('Creating...') : t('Package')}
              </button>
            </div>
          </form>

          <div>
            <h4 className="text-xs font-semibold text-slate-700 mb-2">{t('Exported packages')}:</h4>
            {pkgs.length === 0 ? (
              <p className="text-xs text-slate-400 italic">{t('No packages created yet.')}</p>
            ) : (
              <div className="space-y-1.5 max-h-48 overflow-y-auto">
                {pkgs.map((p) => (
                  <div
                    key={p.name}
                    className="flex items-center justify-between rounded border border-slate-200 p-2 text-xs bg-slate-50"
                  >
                    <div>
                      <p className="font-medium text-slate-800">{p.name}</p>
                      <p className="text-[10px] text-slate-400 font-mono">
                        {fmtSize(p.size)} · {p.created_at} · SHA256: {p.sha256?.slice(0, 16)}...
                      </p>
                    </div>
                    <a
                      href={api.imageUrl(p.id)}
                      download
                      className="rounded bg-white px-2.5 py-1 text-xs border border-slate-300 text-slate-700 hover:bg-slate-100 flex items-center gap-1 cursor-pointer"
                    >
                      <Download size={12} /> Tải về
                    </a>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  )
}

// -------------------------------------------------------------
// MODAL QUẢN LÝ THIẾT BỊ VỤ ÁN
// -------------------------------------------------------------
function DeviceMgrModal({
  name,
  devs,
  onClose,
}: {
  name: string
  devs: { items: Device[]; unassigned: number } | null
  onClose: () => void
}) {
  const [newDevName, setNewDevName] = useState('')
  const [newDevType, setNewDevType] = useState<DeviceType>('phone')
  const [busy, setBusy] = useState(false)
  const { t } = useI18n()

  const addDevice = async (e: FormEvent) => {
    e.preventDefault()
    if (!newDevName.trim()) return
    setBusy(true)
    try {
      await api.createDevice(name, newDevName.trim(), newDevType)
      setNewDevName('')
      onClose()
    } catch {} finally {
      setBusy(false)
    }
  }

  const removeDevice = async (dn: string) => {
    if (!window.confirm('Xoá thiết bị "' + dn + '" và toàn bộ tài liệu của nó?')) return
    setBusy(true)
    try {
      await api.deleteDevice(name, dn)
      onClose()
    } catch {} finally {
      setBusy(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4">
      <div className="w-full max-w-lg rounded-xl bg-white shadow-2xl overflow-hidden">
        <div className="flex h-11 items-center justify-between bg-[#0f2a4a] text-white px-4">
          <span className="font-bold text-xs flex items-center gap-2 text-[#00bcd4]">
            <HardDrive size={14} />
            Quản lý thiết bị thu giữ trong vụ án
          </span>
          <button type="button" onClick={onClose} className="text-slate-400 hover:text-white cursor-pointer">
            <X size={16} />
          </button>
        </div>

        <div className="p-4 space-y-4">
          <form onSubmit={addDevice} className="space-y-2">
            <label className="block text-xs font-semibold text-slate-700">
              Đăng ký thêm thiết bị mới:
            </label>
            <div className="flex gap-2">
              <input
                type="text"
                placeholder={t('Device name (e.g. iPhone 13 of Le Van C)...')}
                value={newDevName}
                onChange={(e) => setNewDevName(e.target.value)}
                className="flex-1 rounded border border-slate-300 p-2 text-xs"
              />
              <select
                value={newDevType}
                onChange={(e) => setNewDevType(e.target.value as DeviceType)}
                className="rounded border border-slate-300 p-2 text-xs"
              >
                <option value="phone">{t('Phone')}</option>
                <option value="laptop">{t('Laptop / PC')}</option>
                <option value="hdd">{t('HDD / USB drive')}</option>
                <option value="camera">{t('Camera DVR')}</option>
                <option value="other">{t('Other')}</option>
              </select>
              <button
                type="submit"
                disabled={busy}
                className="rounded bg-[#2f6fed] hover:bg-[#2458c9] px-3 py-2 text-xs font-medium text-white disabled:opacity-50 cursor-pointer"
              >
                Thêm
              </button>
            </div>
          </form>

          <div>
            <h4 className="text-xs font-semibold text-slate-700 mb-2">
              Danh sách thiết bị ({devs?.items.length || 0}):
            </h4>
            <div className="space-y-1.5 max-h-52 overflow-y-auto">
              {devs?.items.map((d) => (
                <div
                  key={d.name}
                  className="flex items-center justify-between rounded border border-slate-200 p-2 text-xs bg-slate-50"
                >
                  <div className="flex items-center gap-2">
                    <Smartphone size={14} className="text-slate-500" />
                    <div>
                      <p className="font-semibold text-slate-800">{d.name}</p>
                      <p className="text-[10.5px] text-slate-500">{t(DEVICE_LABELS[d.type])}</p>
                    </div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-[11px] text-slate-500 font-medium">
                      {d.count || 0} tệp chứng cứ
                    </span>
                    <button
                      type="button"
                      onClick={() => removeDevice(d.name)}
                      disabled={busy}
                      className="text-red-500 hover:text-red-700 cursor-pointer disabled:opacity-40"
                      title="Xoá thiết bị"
                    >
                      <Trash2 size={14} />
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  )
}
