import { Suspense, lazy } from 'react'
import type { ReactNode } from 'react'
import { Navigate, Route, Routes } from 'react-router-dom'
import { getUser } from './auth'
import { NotificationProvider } from './notify'
import Login from './pages/Login'

const CaseDetail = lazy(() => import('./pages/CaseDetail'))
const Devices = lazy(() => import('./pages/Devices'))
const Loading = <div className="h-screen w-screen bg-[#0a1f44] flex items-center justify-center text-white text-sm">Đang tải...</div>

function RequireAuth({ children }: { children: ReactNode }) {
  return getUser() ? children : <Navigate to="/login" replace />
}

export default function App() {
  return (
    <NotificationProvider>
    <Routes>
      <Route path="/login" element={<Login />} />
      {/* Màn chính: danh sách thiết bị đang cắm -> Đóng image -> Trích xuất -> View */}
      <Route
        path="/"
        element={
          <RequireAuth>
            <Suspense fallback={Loading}><Devices /></Suspense>
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
                <div className="h-screen w-screen bg-[#0a1f44] flex items-center justify-center text-white text-sm">
                  Đang nạp giao diện điều tra Magnet AXIOM...
                </div>
              }
            >
              <CaseDetail />
            </Suspense>
          </RequireAuth>
        }
      />
      {/* Màn riêng xem dữ liệu đã trích xuất của một thiết bị */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
    </NotificationProvider>
  )
}
