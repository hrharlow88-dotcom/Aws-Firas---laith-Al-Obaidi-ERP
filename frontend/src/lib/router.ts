import { useEffect, useState } from 'react';

/**
 * Hash routes, so a profile, run or payslip has its own link and survives a
 * refresh or a print dialog: #/employees/<id>, #/payroll/<runId>, …
 */
export interface Route {
  page: string;
  params: string[];
}

export function parseRoute(hash = window.location.hash): Route {
  const parts = hash.replace(/^#\/?/, '').split('/').filter(Boolean).map(decodeURIComponent);
  return { page: parts[0] || 'home', params: parts.slice(1) };
}

export function navigate(page: string, ...params: string[]): void {
  const next = `#/${[page, ...params].map(encodeURIComponent).join('/')}`;
  if (window.location.hash !== next) window.location.hash = next;
}

export function useRoute(): Route {
  const [route, setRoute] = useState(parseRoute);
  useEffect(() => {
    const onChange = () => {
      setRoute(parseRoute());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', onChange);
    return () => window.removeEventListener('hashchange', onChange);
  }, []);
  return route;
}
