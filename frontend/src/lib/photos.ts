import { useEffect, useState } from 'react';
import { api } from './api';
import { useSession } from './session';

/**
 * Small employee photos for lists and the org chart. They are fetched up to 200 in one
 * request (offices share one internet address, and the server limits requests per
 * address), kept in memory for this sign-in only, and keyed by the photo itself, so a
 * replaced photo shows at once and a person signing in after another starts empty.
 */
const cache = new Map<string, string>();
let cacheToken = '';

export interface PhotoHolder { id: string; photoVersion?: string | null; photoDocumentId?: string | null }

const versionOf = (person: PhotoHolder) => person.photoVersion ?? person.photoDocumentId ?? null;

export function useEmployeeThumbs(people: PhotoHolder[]): Record<string, string> {
  const { token } = useSession();
  const [, setLoaded] = useState(0);
  if (token !== cacheToken) {
    cache.clear();
    cacheToken = token;
  }
  const wanted = people.filter((person) => versionOf(person));
  const key = wanted.map((person) => `${person.id}:${versionOf(person)}`).join(',');
  useEffect(() => {
    const missing = wanted.filter((person) => !cache.has(`${person.id}:${versionOf(person)}`));
    if (!missing.length) return;
    let live = true;
    void (async () => {
      for (let start = 0; start < missing.length; start += 200) {
        const chunk = missing.slice(start, start + 200);
        try {
          const result = await api<{ data: Record<string, { v: string; src: string }> }>('/employees/photos/thumbs', token, { body: { ids: chunk.map((person) => person.id) } });
          for (const [id, thumb] of Object.entries(result.data)) cache.set(`${id}:${thumb.v}`, thumb.src);
        } catch { /* the initials stay */ }
        if (live) setLoaded((count) => count + 1);
      }
    })();
    return () => { live = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, token]);
  const found: Record<string, string> = {};
  for (const person of wanted) {
    const src = cache.get(`${person.id}:${versionOf(person)}`);
    if (src) found[person.id] = src;
  }
  return found;
}
