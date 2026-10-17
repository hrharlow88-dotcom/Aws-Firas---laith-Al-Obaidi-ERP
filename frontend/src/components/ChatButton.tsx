import { MessagesSquare } from 'lucide-react';
import { useChatUnread } from '../lib/chatUnread';
import { navigate } from '../lib/router';

/** Chat icon in the top bar with the unread count; kept apart from the chat screen so the app shell stays small. */
export function ChatButton() {
  const unread = useChatUnread();
  return <button className="o-bell-button o-chat-top" title="المحادثات · Discuss" aria-label={`المحادثات (${unread})`} onClick={() => navigate('chat')}><MessagesSquare size={18} />{unread > 0 && <span className="o-bell-count">{unread > 99 ? '99+' : unread}</span>}</button>;
}
