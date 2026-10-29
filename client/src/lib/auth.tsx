import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from 'react';
import { api, setCsrfToken, setUnauthorizedHandler } from './api';

export interface CurrentUser {
  id: number;
  name: string;
  email: string;
  role: 'super_admin' | 'admin' | 'owner' | 'volunteer';
  roleLabel: string;
  permissions: string[];
  mustChangePassword: boolean;
}

interface AuthState {
  user: CurrentUser | null;
  loading: boolean;
  can: (perm: string) => boolean;
  canAny: (...perms: string[]) => boolean;
  login: (email: string, password: string) => Promise<CurrentUser>;
  logout: () => Promise<void>;
  refresh: () => Promise<void>;
}

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<CurrentUser | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      const r = await api.get<{ user: CurrentUser | null; csrfToken: string | null }>('/api/auth/me');
      setCsrfToken(r.csrfToken);
      setUser(r.user);
    } catch {
      setUser(null);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
    setUnauthorizedHandler(() => setUser(null));
  }, [refresh]);

  const login = async (email: string, password: string) => {
    const r = await api.post<{ user: CurrentUser; csrfToken: string }>('/api/auth/login', { email, password });
    setCsrfToken(r.csrfToken);
    setUser(r.user);
    return r.user;
  };
  const logout = async () => {
    await api.post('/api/auth/logout').catch(() => undefined);
    setCsrfToken(null);
    setUser(null);
  };
  const can = (perm: string) => Boolean(user?.permissions.includes(perm));
  const canAny = (...perms: string[]) => perms.some(can);

  return <AuthContext.Provider value={{ user, loading, can, canAny, login, logout, refresh }}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth outside provider');
  return ctx;
}
