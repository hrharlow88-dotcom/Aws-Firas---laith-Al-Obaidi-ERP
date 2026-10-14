import { createContext, ReactNode, useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { Permission, SystemSettings, UserRole } from '../SettingsPage';
import { api, ApiError } from './api';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  role: UserRole;
  branchId: string | null;
}

export interface Session {
  token: string;
  user: SessionUser;
  settings: SystemSettings;
  can: (permission: Permission) => boolean;
  notify: (message: string, isError?: boolean) => void;
  fail: (error: unknown, fallback: string) => void;
  /** Calls the API with the session token. */
  call: <T>(path: string, options?: { method?: string; body?: unknown; form?: FormData }) => Promise<T>;
}

const SessionContext = createContext<Session | null>(null);

export function SessionProvider({ value, children }: { value: Session; children: ReactNode }) {
  return <SessionContext.Provider value={value}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

export function buildSession(
  token: string,
  user: SessionUser,
  settings: SystemSettings,
  notify: (message: string, isError?: boolean) => void,
  onExpired: () => void,
): Session {
  const permissions = new Set(user.role === 'super_admin'
    ? Object.values(settings.roles).flatMap((role) => role.permissions).concat(settings.knownPermissions ?? [])
    : settings.roles[user.role]?.permissions ?? []);
  const fail = (error: unknown, fallback: string) => {
    if (error instanceof ApiError && error.status === 401) {
      onExpired();
      return;
    }
    notify(error instanceof Error ? error.message : fallback, true);
  };
  return {
    token,
    user,
    settings,
    can: (permission) => user.role === 'super_admin' || permissions.has(permission),
    notify,
    fail,
    call: (path, options) => api(path, token, options),
  };
}

/**
 * Loads data for a screen and exposes a reload function. Errors go to the
 * shared notice bar; stale responses from an earlier key are ignored.
 */
export function useLoad<T>(path: string | null, fallback: T): { data: T; loading: boolean; reload: () => void } {
  const session = useSession();
  const [data, setData] = useState<T>(fallback);
  const [loading, setLoading] = useState(Boolean(path));
  const [version, setVersion] = useState(0);
  useEffect(() => {
    if (!path) {
      setLoading(false);
      return;
    }
    let current = true;
    setLoading(true);
    session.call<{ data: T }>(path)
      .then((result) => {
        if (current) setData(result.data);
      })
      .catch((error: unknown) => {
        if (current) session.fail(error, 'تعذر تحميل البيانات.');
      })
      .finally(() => {
        if (current) setLoading(false);
      });
    return () => { current = false; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, version, session.token]);
  const reload = useCallback(() => setVersion((value) => value + 1), []);
  return useMemo(() => ({ data, loading, reload }), [data, loading, reload]);
}
