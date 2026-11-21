import { Suspense, lazy, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, Route, Routes, useNavigate } from 'react-router-dom'
import { getUser } from './auth'
import { api } from './api'
import Login from './pages/Login'

const CaseDetail = lazy(() => import('./pages/CaseDetail'))

function RequireAuth({ children }: { children: ReactNode }) {
  return getUser() ? children : <Navigate to="/login" replace />
}

// App giờ chỉ còn 1 trang quản lý Magnet AXIOM. Vào gốc `/` → nhảy tới vụ án mới nhất.
function ToLatestCase() {
  const navigate = useNavigate()
  const [checking, setChecking] = useState(true)
  useEffect(() => {
    api.cases()
      .then((cs) => navigate(cs[0]?.name ? `/cases/${encodeURIComponent(cs[0].name)}` : '/cases/Chưa có vụ án', { replace: true }))
      .catch(() => navigate('/cases/Chưa có vụ án', { replace: true }))
      .finally(() => setChecking(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (checking) return <div className="h-screen w-screen bg-[#0f2a4a] flex items-center justify-center text-white text-sm">Đang mở vụ án mới nhất...</div>
  return null
}

export default function App() {
  return (
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Gốc: tự nhảy tới vụ mới nhất, không còn trang quản trị hệ thống */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <ToLatestCase />
          </RequireAuth>
        }
      />
      {/* Trang điều tra vụ án Magnet AXIOM: Toàn màn hình độc lập, không bọc menu/sidebar */}
      <Route
        path="/cases/:name"
        element={
          <RequireAuth>
            <Suspense
              fallback={
                <div className="h-screen w-screen bg-[#0f2a4a] flex items-center justify-center text-white text-sm">
                  Đang nạp giao diện điều tra Magnet AXIOM...
                </div>
              }
            >
              <CaseDetail />
            </Suspense>
          </RequireAuth>
        }
      />
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  )
}