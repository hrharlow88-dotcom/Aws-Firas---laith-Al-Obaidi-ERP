import { useEffect, useState } from 'react';
import { apiBlob } from '../lib/api';
import { useSession } from '../lib/session';

/**
 * Photos are served behind authentication, so they are loaded as blobs. The photo's own
 * version (its document) is part of the address, so a replaced photo is fetched anew
 * instead of coming back from the browser's cache.
 */
export function useEmployeePhoto(employeeId: string | null, hasPhoto: boolean, version = 0, photoVersion?: string | null): string | null {
  const { token } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!employeeId || !hasPhoto) {
      setUrl(null);
      return;
    }
    let current = true;
    let created: string | null = null;
    const query = photoVersion ? `?v=${encodeURIComponent(photoVersion)}` : version ? `?r=${version}` : '';
    apiBlob(`/employees/${employeeId}/photo${query}`, token)
      .then((result) => {
        created = result.url;
        if (current) setUrl(result.url);
        else URL.revokeObjectURL(result.url);
      })
      .catch(() => setUrl(null));
    return () => {
      current = false;
      if (created) URL.revokeObjectURL(created);
    };
  }, [employeeId, hasPhoto, token, version, photoVersion]);
  return url;
}

export function EmployeePhoto({ employeeId, hasPhoto, name, size = 44, version, photoVersion }: {
  employeeId: string;
  hasPhoto: boolean;
  name: string;
  size?: number;
  version?: number;
  photoVersion?: string | null;
}) {
  const url = useEmployeePhoto(employeeId, hasPhoto, version, photoVersion);
  return url
    ? <img className="employee-photo" src={url} alt={name} style={{ width: size, height: size }} />
    : <span className="employee-photo employee-photo-empty" style={{ width: size, height: size, fontSize: size / 2.6 }}>{name.slice(0, 1)}</span>;
}

/** The small square in lists and the org chart: the photo when there is one, otherwise the first letter. */
export function PersonMark({ name, src, className = 'person-mark' }: { name: string; src?: string | null; className?: string }) {
  return src
    ? <img className={`${className} person-mark-photo`} src={src} alt="" loading="lazy" />
    : <span className={className}>{name.trim().slice(0, 1)}</span>;
}
