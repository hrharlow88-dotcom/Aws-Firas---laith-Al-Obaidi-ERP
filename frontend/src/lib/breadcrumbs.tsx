import { createContext, ReactNode, useContext, useEffect, useState } from 'react';

/**
 * Trailing breadcrumb entries set by the page that is open (an employee's
 * name, a payroll month…). The app bar shows them after the app and menu.
 */
export interface Crumb {
  label: string;
  /** Hash route to open when clicked; the last crumb is never a link. */
  href?: string;
}

const CrumbContext = createContext<{ crumbs: Crumb[]; set: (crumbs: Crumb[]) => void }>({ crumbs: [], set: () => undefined });

export function CrumbProvider({ children }: { children: ReactNode }) {
  const [crumbs, set] = useState<Crumb[]>([]);
  // Leaving a page clears what it added.
  useEffect(() => {
    const clear = () => set([]);
    window.addEventListener('hashchange', clear);
    return () => window.removeEventListener('hashchange', clear);
  }, []);
  return <CrumbContext.Provider value={{ crumbs, set }}>{children}</CrumbContext.Provider>;
}

export function useCrumbs(): Crumb[] {
  return useContext(CrumbContext).crumbs;
}

/** Called by a page once it knows what it shows. */
export function useCrumb(...crumbs: Array<Crumb | string | null | undefined | false>): void {
  const { set } = useContext(CrumbContext);
  const list = crumbs.filter(Boolean).map((item) => (typeof item === 'string' ? { label: item } : item as Crumb));
  const key = JSON.stringify(list);
  useEffect(() => {
    set(list);
    return () => set([]);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, set]);
}
