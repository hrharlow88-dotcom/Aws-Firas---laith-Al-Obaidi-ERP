import { useEffect, useState } from 'react';
import { RefreshCw, Sparkles } from 'lucide-react';
import { Dialog, Tone } from './ui';
import { formatDate } from '../lib/format';
import { APP_VERSION, RELEASES, RELEASE_KIND } from '../lib/releases';

/** "1.2" < "1.10" < "2.0"; missing parts count as zero ("1.1" = "1.1.0"). */
export function compareVersions(a: string, b: string): number {
  const left = a.split('.').map(Number);
  const right = b.split('.').map(Number);
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const diff = (left[index] || 0) - (right[index] || 0);
    if (diff) return diff > 0 ? 1 : -1;
  }
  return 0;
}

const shortVersion = (version: string) => version.replace(/\.0$/, '');

/** The running version; opens the release history. */
export function VersionBadge({ className = '' }: { className?: string }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className={`version-badge ${className}`} onClick={() => setOpen(true)} title="ما الجديد · What's new">
        <Sparkles size={12} />v{APP_VERSION}
      </button>
      <WhatsNew open={open} onClose={() => setOpen(false)} />
    </>
  );
}

export function WhatsNew({ open, onClose }: { open: boolean; onClose: () => void }) {
  return (
    <Dialog open={open} title="ما الجديد · What's new" subtitle={`النسخة الحالية v${APP_VERSION}`} onClose={onClose} wide>
      <ol className="release-list">
        {RELEASES.map((release) => (
          <li key={release.version}>
            <div className="release-head">
              <strong className="release-version">v{release.version}</strong>
              <span><b>{release.title}</b><small dir="ltr">{release.titleEn}</small></span>
              <time dateTime={release.date}>{formatDate(release.date)}</time>
            </div>
            <ul>
              {release.items.map((item) => (
                <li key={item.ar}>
                  <Tone tone={RELEASE_KIND[item.kind].tone}>{RELEASE_KIND[item.kind].ar}</Tone>
                  <span>{item.ar}<small dir="ltr">{item.en}</small></span>
                </li>
              ))}
            </ul>
          </li>
        ))}
      </ol>
    </Dialog>
  );
}

/** Reloads past any cached copy of the app (service worker included). */
async function reloadFresh() {
  try {
    const registration = await navigator.serviceWorker?.getRegistration();
    await registration?.update();
  } catch { /* the reload below still fetches the new page */ }
  window.location.reload();
}

/**
 * A tab left open keeps running the version it loaded. This asks the server
 * which version it runs (every few minutes and whenever the tab comes back)
 * and offers a reload when a newer one is out.
 */
export function UpdateBanner() {
  const [server, setServer] = useState<string | null>(null);
  useEffect(() => {
    let active = true;
    const check = () => {
      fetch('/api/health', { cache: 'no-store' })
        .then((response) => (response.ok ? response.json() : null))
        .then((data: { version?: string } | null) => { if (active && data?.version) setServer(data.version); })
        .catch(() => undefined);
    };
    check();
    const timer = window.setInterval(check, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') check(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => { active = false; window.clearInterval(timer); document.removeEventListener('visibilitychange', onVisible); };
  }, []);
  if (!server || compareVersions(server, APP_VERSION) <= 0) return null;
  return (
    <div className="update-banner no-print" role="status">
      <RefreshCw size={15} />
      <span>نسخة جديدة من النظام v{shortVersion(server)} متاحة · A new version is available</span>
      <button type="button" className="button button-primary button-small" onClick={() => void reloadFresh()}>تحديث الآن</button>
    </div>
  );
}
