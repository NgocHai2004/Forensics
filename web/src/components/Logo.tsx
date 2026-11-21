// Khiên + vân tay. big = bản 56px trên trang đăng nhập, mặc định 28px; mark = chỉ biểu tượng (thanh menu icon).
export default function Logo({ big = false, mark = false, size }: { big?: boolean; mark?: boolean; size?: number }) {
  const px = size ?? (big ? 56 : 28)
  return (
    <span className={`inline-flex items-center gap-2 font-display font-bold leading-none ${big ? 'text-2xl' : 'text-sm'}`}>
      <svg width={px} height={px} viewBox="0 0 24 24" aria-hidden="true">
        <path d="M12 2 4 5v6c0 5 3.4 9.4 8 11 4.6-1.6 8-6 8-11V5z" fill="var(--color-navy)" />
        <g fill="none" stroke="var(--color-primary)" strokeWidth="1.3" strokeLinecap="round">
          <path d="M7 11a5 5 0 0 1 10 0v2" />
          <path d="M9 12a3 3 0 0 1 6 0v3.2" />
          <path d="M11 12.3a1 1 0 0 1 2 0v4" />
        </g>
      </svg>
      {!mark && <span>
        <span className="text-navy">MOBILE</span> <span className="text-primary">FORENSIC</span>
      </span>}
    </span>
  )
}
