import { FormEvent, KeyboardEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  AtSign, Download, Hash, Lock, MessageCircle, MessagesSquare, Paperclip, Pencil, Plus, Reply, Search, Send, SmilePlus, Trash2, UserPlus, Users, X,
} from 'lucide-react';
import { Bi } from '../components/Brand';
import { Dialog, Empty } from '../components/ui';
import { apiBlob, downloadFile } from '../lib/api';
import { navigate } from '../lib/router';
import { useSession } from '../lib/session';

interface Channel {
  id: string; kind: 'channel' | 'direct'; name: string; description: string | null; isPrivate: boolean; lastMessageAt: string | null;
  otherUserId: string | null; online: boolean | null; unread: number; preview: string | null; members: number; muted: boolean;
}
interface Person { id: string; name: string; role: string; position: string | null; branchName: string | null; online: boolean | null }
interface Message {
  id: string; channelId: string; userId: string; userName: string; userRole: string; body: string | null; replyTo: string | null;
  replyBody: string | null; replyName: string | null; attachmentName: string | null; attachmentMime: string | null; attachmentSize: number | null;
  reactions: Record<string, string[]>; createdAt: string; editedAt: string | null; deletedAt: string | null;
}

const REACTIONS = ['👍', '❤️', '😂', '🎉', '👏', '✅', '👀', '🙏'];
const COLORS = ['#e15532', '#3e8ed0', '#3fae8c', '#9b6bd6', '#e3a83b', '#d4657d', '#16a3a3', '#5b8def'];
const colorOf = (id: string) => COLORS[[...id].reduce((sum, char) => sum + char.charCodeAt(0), 0) % COLORS.length];
const time = (value: string) => new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Baghdad' }).format(new Date(value));
const day = (value: string) => new Intl.DateTimeFormat('ar-IQ-u-nu-latn', { weekday: 'long', day: 'numeric', month: 'long', timeZone: 'Asia/Baghdad' }).format(new Date(value));

function Avatar({ id, name, online }: { id: string; name: string; online?: boolean | null }) {
  return <span className="chat-avatar" style={{ background: colorOf(id) }}>{name.trim().slice(0, 1)}{online !== undefined && <i className={online ? 'is-online' : ''} />}</span>;
}

function ImagePreview({ messageId }: { messageId: string }) {
  const session = useSession();
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let live = true;
    let made: string | null = null;
    void apiBlob(`/chat/messages/${messageId}/file?inline=1`, session.token).then((result) => { made = result.url; if (live) setUrl(result.url); }).catch(() => undefined);
    return () => { live = false; if (made) URL.revokeObjectURL(made); };
  }, [messageId, session.token]);
  return url ? <img className="chat-image" src={url} alt="" /> : <span className="chat-image is-loading" />;
}

/** Internal chat like Odoo Discuss: company channels, private groups and direct messages. */
export function ChatPage({ channelId }: { channelId?: string }) {
  const session = useSession();
  const me = session.user.id;
  const [channels, setChannels] = useState<Channel[]>([]);
  const [discover, setDiscover] = useState<Array<{ id: string; name: string; description: string | null; members: number }>>([]);
  const [people, setPeople] = useState<Person[]>([]);
  const [messages, setMessages] = useState<Message[]>([]);
  const [text, setText] = useState('');
  const [replyTo, setReplyTo] = useState<Message | null>(null);
  const [editing, setEditing] = useState<Message | null>(null);
  const [file, setFile] = useState<File | null>(null);
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(false);
  const [starting, setStarting] = useState(false);
  const [showMembers, setShowMembers] = useState(false);
  const [members, setMembers] = useState<Array<{ id: string; name: string; role: string }>>([]);
  const [busy, setBusy] = useState(false);
  const lastAt = useRef<string | null>(null);
  const list = useRef<HTMLDivElement>(null);
  const atBottom = useRef(true);
  const active = channels.find((channel) => channel.id === channelId) ?? null;

  const loadChannels = useCallback(async (background = false) => {
    try {
      const result = await session.call<{ data: { channels: Channel[]; discover: typeof discover } }>('/chat/channels', { background });
      setChannels(result.data.channels);
      setDiscover(result.data.discover);
      if (!channelId && result.data.channels[0]) navigate('chat', result.data.channels[0].id);
    } catch (error) { if (!background) session.fail(error, 'تعذر تحميل المحادثات.'); }
  }, [session, channelId]);

  useEffect(() => { void loadChannels(); void session.call<{ data: Person[] }>('/chat/people').then((result) => setPeople(result.data)).catch(() => undefined); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { const timer = window.setInterval(() => void loadChannels(true), 10000); return () => window.clearInterval(timer); }, [loadChannels]);

  const merge = (incoming: Message[]) => setMessages((current) => {
    const map = new Map(current.map((message) => [message.id, message]));
    for (const message of incoming) map.set(message.id, message);
    return [...map.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  });

  const poll = useCallback(async (initial = false) => {
    if (!channelId) return;
    try {
      const query = !initial && lastAt.current ? `?after=${encodeURIComponent(lastAt.current)}` : '';
      const result = await session.call<{ data: Message[] }>(`/chat/channels/${channelId}/messages${query}`, { background: !initial });
      if (initial) setMessages(result.data); else if (result.data.length) merge(result.data);
      const stamps = result.data.flatMap((message) => [message.createdAt, message.editedAt, message.deletedAt]).filter(Boolean) as string[];
      if (stamps.length) { const sorted = stamps.sort(); lastAt.current = sorted[sorted.length - 1]; }
      if (result.data.length) void session.call(`/chat/channels/${channelId}/read`, { method: 'POST', background: true }).catch(() => undefined);
    } catch { /* the next round retries */ }
  }, [channelId, session]);

  useEffect(() => {
    lastAt.current = null;
    setMessages([]);
    setReplyTo(null);
    setEditing(null);
    void poll(true);
    const timer = window.setInterval(() => void poll(), 3000);
    return () => window.clearInterval(timer);
  }, [channelId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (atBottom.current && list.current) list.current.scrollTop = list.current.scrollHeight;
  }, [messages]);

  async function send(event?: FormEvent) {
    event?.preventDefault();
    if (!channelId || (!text.trim() && !file)) return;
    setBusy(true);
    try {
      if (editing) {
        await session.call(`/chat/messages/${editing.id}`, { method: 'PATCH', body: { body: text.trim() } });
        setEditing(null);
      } else if (file) {
        const form = new FormData();
        form.set('file', file);
        if (text.trim()) form.set('body', text.trim());
        if (replyTo) form.set('replyTo', replyTo.id);
        await session.call(`/chat/channels/${channelId}/messages`, { form });
      } else {
        await session.call(`/chat/channels/${channelId}/messages`, { method: 'POST', body: { body: text.trim(), replyTo: replyTo?.id } });
      }
      setText(''); setFile(null); setReplyTo(null);
      atBottom.current = true;
      await poll();
      void loadChannels(true);
    } catch (error) { session.fail(error, 'تعذر الإرسال.'); } finally { setBusy(false); }
  }

  const mention = /@([^\s@]{0,20})$/.exec(text);
  const suggestions = mention ? people.filter((person) => person.name.includes(mention[1])).slice(0, 6) : [];
  function onKey(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); }
    if (event.key === 'Escape') { setEditing(null); setReplyTo(null); setText(''); }
  }

  async function startDirect(person: Person) {
    try {
      const result = await session.call<{ data: { id: string } }>('/chat/direct', { method: 'POST', body: { userId: person.id } });
      setStarting(false);
      await loadChannels(true);
      navigate('chat', result.data.id);
    } catch (error) { session.fail(error, 'تعذر بدء المحادثة.'); }
  }
  async function createChannel(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    try {
      const result = await session.call<{ data: { id: string } }>('/chat/channels', { method: 'POST', body: {
        name: form.get('name'), description: form.get('description') || null, isPrivate: form.get('private') === 'on', memberIds: form.getAll('members'),
      } });
      setCreating(false);
      await loadChannels(true);
      navigate('chat', result.data.id);
    } catch (error) { session.fail(error, 'تعذر إنشاء القناة.'); }
  }
  async function openMembers() {
    if (!channelId) return;
    const result = await session.call<{ data: typeof members }>(`/chat/channels/${channelId}/members`);
    setMembers(result.data);
    setShowMembers(true);
  }

  const groups = useMemo(() => {
    const out: Array<{ day: string; items: Message[] }> = [];
    for (const message of messages) {
      const label = day(message.createdAt);
      if (!out.length || out[out.length - 1].day !== label) out.push({ day: label, items: [] });
      out[out.length - 1].items.push(message);
    }
    return out;
  }, [messages]);

  const shown = channels.filter((channel) => !filter.trim() || channel.name?.includes(filter.trim()));
  const channelRows = shown.filter((channel) => channel.kind === 'channel');
  const directRows = shown.filter((channel) => channel.kind === 'direct');

  const row = (channel: Channel) => <button key={channel.id} className={`chat-channel ${channel.id === channelId ? 'is-active' : ''} ${channel.unread ? 'has-unread' : ''}`} onClick={() => navigate('chat', channel.id)}>
    {channel.kind === 'direct' ? <Avatar id={channel.otherUserId ?? channel.id} name={channel.name ?? '؟'} online={channel.online} /> : <span className="chat-hash">{channel.isPrivate ? <Lock size={14} /> : <Hash size={15} />}</span>}
    <span className="chat-channel-text"><strong>{channel.name}</strong>{channel.preview && <small>{channel.preview}</small>}</span>
    {channel.unread > 0 && <b className="chat-badge">{channel.unread > 99 ? '99+' : channel.unread}</b>}
  </button>;

  return (
    <section className="chat-shell">
      <aside className="chat-side">
        <div className="chat-side-head"><h2><MessagesSquare size={20} /><Bi ar="المحادثات" en="Discuss" /></h2></div>
        <label className="chat-search"><Search size={15} /><input value={filter} onChange={(event) => setFilter(event.target.value)} placeholder="بحث… · Search" /></label>
        <div className="chat-group-head"><span>القنوات · Channels</span><button className="icon-button" title="قناة جديدة" onClick={() => setCreating(true)}><Plus size={15} /></button></div>
        {channelRows.map(row)}
        {discover.length > 0 && <details className="chat-discover"><summary>قنوات عامة للانضمام ({discover.length})</summary>
          {discover.map((item) => <button key={item.id} className="chat-channel" onClick={async () => { await session.call(`/chat/channels/${item.id}/join`, { method: 'POST' }); await loadChannels(true); navigate('chat', item.id); }}>
            <span className="chat-hash"><Hash size={15} /></span><span className="chat-channel-text"><strong>{item.name}</strong><small>{item.members} عضو · انضمام</small></span></button>)}
        </details>}
        <div className="chat-group-head"><span>الرسائل المباشرة · Direct</span><button className="icon-button" title="محادثة جديدة" onClick={() => setStarting(true)}><Plus size={15} /></button></div>
        {directRows.map(row)}
      </aside>

      <div className="chat-main">
        {!active ? <Empty icon={<MessageCircle size={22} />} title="اختر محادثة" text="أو ابدأ رسالة مباشرة مع زميل." /> : <>
          <header className="chat-head">
            {active.kind === 'direct' ? <Avatar id={active.otherUserId ?? active.id} name={active.name} online={active.online} /> : <span className="chat-hash big">{active.isPrivate ? <Lock size={17} /> : <Hash size={18} />}</span>}
            <div><strong>{active.name}</strong><small>{active.kind === 'direct' ? (active.online ? 'متصل الآن · Online' : 'غير متصل · Away') : active.description ?? `${active.members} عضو`}</small></div>
            {active.kind === 'channel' && <div className="chat-head-actions">
              <button className="button button-quiet button-small" onClick={() => void openMembers()}><Users size={14} />{active.members}</button>
            </div>}
          </header>
          <div className="chat-messages" ref={list} onScroll={(event) => { const el = event.currentTarget; atBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80; }}>
            {groups.map((group) => <div key={group.day}>
              <div className="chat-day"><span>{group.day}</span></div>
              {group.items.map((message, index) => {
                const previous = group.items[index - 1];
                const compact = previous && previous.userId === message.userId && new Date(message.createdAt).getTime() - new Date(previous.createdAt).getTime() < 5 * 60000 && !message.replyTo;
                const mine = message.userId === me;
                return <article key={message.id} className={`chat-message ${compact ? 'is-compact' : ''} ${mine ? 'is-mine' : ''}`}>
                  {!compact ? <Avatar id={message.userId} name={message.userName} /> : <span className="chat-time-gutter">{time(message.createdAt)}</span>}
                  <div className="chat-bubble-wrap">
                    {!compact && <div className="chat-meta"><strong style={{ color: colorOf(message.userId) }}>{message.userName}</strong><small>{time(message.createdAt)}</small></div>}
                    {message.replyTo && <div className="chat-reply-quote"><Reply size={12} /><b>{message.replyName}</b> {message.replyBody}</div>}
                    {message.deletedAt ? <p className="chat-deleted">حُذفت هذه الرسالة · Message deleted</p> : <>
                      {message.body && <p className="chat-body">{message.body.split(/(@[^\s@]+(?:\s[^\s@]+)?)/g).map((part, i) => part.startsWith('@') ? <mark key={i}>{part}</mark> : part)}</p>}
                      {message.attachmentName && (message.attachmentMime?.startsWith('image/')
                        ? <ImagePreview messageId={message.id} />
                        : <button className="chat-file" onClick={() => void downloadFile(`/chat/messages/${message.id}/file`, session.token, message.attachmentName!)}><Paperclip size={14} />{message.attachmentName}<small>{message.attachmentSize ? `${Math.ceil(message.attachmentSize / 1024)} KB` : ''}</small><Download size={14} /></button>)}
                      {message.editedAt && <small className="chat-edited">(معدّلة)</small>}
                    </>}
                    {Object.entries(message.reactions ?? {}).some(([, users]) => users.length) && <div className="chat-reactions">
                      {Object.entries(message.reactions).filter(([, users]) => users.length).map(([emoji, users]) => <button key={emoji} className={users.includes(me) ? 'is-mine' : ''}
                        onClick={async () => { await session.call(`/chat/messages/${message.id}/react`, { method: 'POST', body: { emoji } }); void poll(); }}>{emoji} {users.length}</button>)}
                    </div>}
                  </div>
                  {!message.deletedAt && <div className="chat-tools">
                    <details className="chat-react-menu"><summary title="تفاعل"><SmilePlus size={15} /></summary><div>{REACTIONS.map((emoji) => <button key={emoji} onClick={async (event) => {
                      (event.currentTarget.closest('details') as HTMLDetailsElement).open = false;
                      await session.call(`/chat/messages/${message.id}/react`, { method: 'POST', body: { emoji } }); void poll();
                    }}>{emoji}</button>)}</div></details>
                    <button title="رد" onClick={() => setReplyTo(message)}><Reply size={15} /></button>
                    {mine && message.body && <button title="تعديل" onClick={() => { setEditing(message); setText(message.body ?? ''); }}><Pencil size={14} /></button>}
                    {(mine || session.user.role === 'super_admin') && <button title="حذف" onClick={async () => { if (window.confirm('حذف الرسالة؟')) { await session.call(`/chat/messages/${message.id}`, { method: 'DELETE' }); void poll(); } }}><Trash2 size={14} /></button>}
                  </div>}
                </article>;
              })}
            </div>)}
            {!messages.length && <p className="chat-empty">ابدأ المحادثة… · Say hello</p>}
          </div>
          <form className="chat-composer" onSubmit={(event) => void send(event)}>
            {(replyTo || editing || file) && <div className="chat-composer-bar">
              {replyTo && <span><Reply size={13} />رد على <b>{replyTo.userName}</b>: {replyTo.body?.slice(0, 80)}</span>}
              {editing && <span><Pencil size={13} />تعديل رسالة</span>}
              {file && <span><Paperclip size={13} />{file.name}</span>}
              <button type="button" className="icon-button" onClick={() => { setReplyTo(null); setEditing(null); setFile(null); if (editing) setText(''); }}><X size={14} /></button>
            </div>}
            {suggestions.length > 0 && <div className="chat-mentions">{suggestions.map((person) => <button type="button" key={person.id} onClick={() => setText(text.replace(/@([^\s@]{0,20})$/, `@${person.name} `))}>
              <Avatar id={person.id} name={person.name} online={person.online} /><span>{person.name}<small>{person.position ?? person.role}</small></span></button>)}</div>}
            <label className="chat-attach" title="إرفاق ملف"><Paperclip size={18} /><input type="file" hidden onChange={(event) => setFile(event.target.files?.[0] ?? null)} /></label>
            <textarea value={text} onChange={(event) => setText(event.target.value)} onKeyDown={onKey} rows={1} placeholder={`اكتب رسالة إلى ${active.name}… (Enter للإرسال، @ للإشارة)`} />
            <button type="button" className="chat-at" title="إشارة" onClick={() => setText(`${text}@`)}><AtSign size={17} /></button>
            <button className="button button-primary chat-send" disabled={busy || (!text.trim() && !file)}><Send size={16} /></button>
          </form>
        </>}
      </div>

      <Dialog open={creating} title="قناة جديدة · New channel" onClose={() => setCreating(false)}>
        <form className="form-grid" onSubmit={(event) => void createChannel(event)}>
          <label className="field settings-wide"><span>الاسم *</span><input name="name" required maxLength={80} placeholder="مثل: فريق المبيعات — بغداد" /></label>
          <label className="field settings-wide"><span>الوصف</span><input name="description" maxLength={300} /></label>
          <label className="settings-check settings-wide"><input type="checkbox" name="private" />قناة خاصة (بالدعوة فقط)</label>
          <label className="field settings-wide"><span>الأعضاء</span><select name="members" multiple size={8}>{people.map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select></label>
          <div className="dialog-actions settings-wide"><button className="button button-primary">إنشاء</button></div>
        </form>
      </Dialog>
      <Dialog open={starting} title="رسالة مباشرة · Direct message" onClose={() => setStarting(false)}>
        <div className="chat-people">{people.map((person) => <button key={person.id} className="chat-channel" onClick={() => void startDirect(person)}>
          <Avatar id={person.id} name={person.name} online={person.online} /><span className="chat-channel-text"><strong>{person.name}</strong><small>{[person.position, person.branchName].filter(Boolean).join(' · ') || person.role}</small></span>
        </button>)}</div>
      </Dialog>
      <Dialog open={showMembers} title={`أعضاء ${active?.name ?? ''}`} onClose={() => setShowMembers(false)}>
        <div className="chat-people">{members.map((member) => <div key={member.id} className="chat-channel"><Avatar id={member.id} name={member.name} /><span className="chat-channel-text"><strong>{member.name}</strong><small>{member.role}</small></span></div>)}</div>
        <form className="filter-bar" onSubmit={async (event) => {
          event.preventDefault();
          const ids = Array.from((event.currentTarget.elements.namedItem('add') as HTMLSelectElement).selectedOptions).map((option) => option.value);
          await session.call(`/chat/channels/${channelId}/members`, { method: 'POST', body: { userIds: ids } });
          await openMembers(); void loadChannels(true);
        }}>
          <select name="add" multiple size={5}>{people.filter((person) => !members.some((member) => member.id === person.id)).map((person) => <option key={person.id} value={person.id}>{person.name}</option>)}</select>
          <button className="button button-quiet"><UserPlus size={14} />إضافة</button>
        </form>
      </Dialog>
    </section>
  );
}

/** Chat icon in the top bar with the unread count. */
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
