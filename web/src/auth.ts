const KEY = 'mf_user'

export const getUser = () => {
  // Ưu tiên session, sau đó là local storage
  const u = sessionStorage.getItem(KEY) || localStorage.getItem(KEY)
  if (u) return u

  // Hỗ trợ kiểm thử hoặc tham số debug url
  if (typeof window !== 'undefined') {
    const sp = new URLSearchParams(window.location.search)
    const token = sp.get('user') || sp.get('auth')
    if (token) {
      sessionStorage.setItem(KEY, token)
      return token
    }
  }
  return null
}

export const login = (name: string) => {
  sessionStorage.setItem(KEY, name)
  localStorage.setItem(KEY, name)
}

export const logout = () => {
  sessionStorage.removeItem(KEY)
  localStorage.removeItem(KEY)
}
