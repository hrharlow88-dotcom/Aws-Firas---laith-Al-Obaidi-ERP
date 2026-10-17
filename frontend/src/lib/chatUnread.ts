import { useEffect, useState } from 'react';
import { useSession } from './session';

/**
 * The unread chat count, polled once for the whole app however many places
 * show it (the top bar on computers, the bottom bar on phones).
 */
let count = 0;
let timer = 0;
let call: (() => Promise<number>) | null = null;
const listeners = new Set<(value: number) => void>();

async function refresh() {
  if (!call) return;
  try {
    count = await call();
    listeners.forEach((listener) => listener(count));
  } catch { /* the next round tries again */ }
}

export function useChatUnread(): number {
  const session = useSession();
  const [value, setValue] = useState(count);
  useEffect(() => {
    call = () => session.call<{ data: { unread: number } }>('/chat/unread', { background: true }).then((result) => result.data.unread);
    listeners.add(setValue);
    if (listeners.size === 1) {
      void refresh();
      timer = window.setInterval(() => void refresh(), 20000);
    } else setValue(count);
    return () => {
      listeners.delete(setValue);
      if (!listeners.size) { window.clearInterval(timer); timer = 0; }
    };
  }, [session]);
  return value;
}
