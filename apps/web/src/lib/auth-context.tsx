'use client';

import { useRouter } from 'next/navigation';
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import { api, ApiError, errorMessage, onUnauthenticated } from './api';
import type { Me } from './types';

interface AuthState {
  me: Me | null;
  /** يعيد قراءة الصلاحيات من الخادم (مثلًا بعد رفض 403 بسبب تغيير صلاحيات). */
  refresh: () => Promise<void>;
  logout: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside <AuthProvider>');
  return ctx;
}

export function loginUrl(pathname: string): string {
  return pathname && pathname !== '/' ? `/login?next=${encodeURIComponent(pathname)}` : '/login';
}

/** يحمّل المستخدم الحالي من الخادم. الجلسة الفعلية في Cookie HttpOnly لا تقرؤها الواجهة. */
export function AuthProvider({
  children,
  fallback,
  errorView,
}: {
  children: ReactNode;
  fallback: ReactNode;
  errorView: (message: string, retry: () => void) => ReactNode;
}) {
  const router = useRouter();
  const [me, setMe] = useState<Me | null>(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMe(await api<Me>('/auth/me'));
      setError(null);
    } catch (e) {
      if (!(e instanceof ApiError && e.status === 401)) setError(errorMessage(e));
    }
  }, []);

  useEffect(() => {
    onUnauthenticated(() => router.replace(loginUrl(window.location.pathname)));
    void refresh();
    return () => onUnauthenticated(null);
  }, [refresh, router]);

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST' });
    } catch (error) {
      if (!(error instanceof ApiError && error.status === 401)) throw error;
    }
    setMe(null);
    router.replace('/login');
  }, [router]);

  const value = useMemo(() => ({ me, refresh, logout }), [me, refresh, logout]);

  if (error && !me) return <>{errorView(error, () => void refresh())}</>;
  if (!me) return <>{fallback}</>;
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
