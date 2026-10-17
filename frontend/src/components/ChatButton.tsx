import { useEffect, useState } from 'react';
import { MessagesSquare } from 'lucide-react';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';

/** Chat icon in the top bar with the unread count; kept apart from the chat screen so the app shell stays small. */
export function ChatButton() {
  const session = useSession();
  const [unread, setUnread] = useState(0);
  useEffect(() => {
    let live = true;
    const load = () => session.call<{ data: { unread: number } }>('/chat/unread', { background: true }).then((result) => { if (live) setUnread(result.data.unread); }).catch(() => undefined);
    void load();
    const timer = window.setInterval(load, 20000);
    return () => { live = false; window.clearInterval(timer); };
  }, [session]);
  return <button className="o-bell-button" title="المحادثات · Discuss" onClick={() => navigate('chat')}><MessagesSquare size={18} />{unread > 0 && <span className="o-bell-count">{unread > 99 ? '99+' : unread}</span>}</button>;
}
