import { useEffect, useState } from 'react';
import { apiBlob } from '../lib/api';
import { useSession } from '../lib/session';

/** Photos are served behind authentication, so they are loaded as blobs. */
export function useEmployeePhoto(employeeId: string | null, hasPhoto: boolean, version = 0): string | null {
  const { token } = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    if (!employeeId || !hasPhoto) {
      setUrl(null);
      return;
    }
    let current = true;
    let created: string | null = null;
    apiBlob(`/employees/${employeeId}/photo`, token)
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
  }, [employeeId, hasPhoto, token, version]);
  return url;
}

export function EmployeePhoto({ employeeId, hasPhoto, name, size = 44, version }: {
  employeeId: string;
  hasPhoto: boolean;
  name: string;
  size?: number;
  version?: number;
}) {
  const url = useEmployeePhoto(employeeId, hasPhoto, version);
  return url
    ? <img className="employee-photo" src={url} alt={name} style={{ width: size, height: size }} />
    : <span className="employee-photo employee-photo-empty" style={{ width: size, height: size, fontSize: size / 2.6 }}>{name.slice(0, 1)}</span>;
}
