import { createClient } from 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm';
import { SUPABASE_URL, SUPABASE_KEY, APP_NAME } from './config.js';

const sb = createClient(SUPABASE_URL, SUPABASE_KEY);
const $ = (s) => document.querySelector(s);
const PAGE_SIZE = 50;
const REACTIONS = ['👍', '🙇', '🎉', '😊', '👏', '😮', '❤️'];

const state = {
  me: null,               // profiles の自分の行
  profiles: new Map(),    // id -> profile
  rooms: [],              // get_my_rooms の結果
  roomFilter: 'all',
  currentRoomId: null,
  members: [],            // 現在ルームの room_members
  messages: [],           // 現在ルーム（古い順）
  reactions: new Map(),   // message_id -> [{user_id, emoji}]
  attachments: new Map(), // message_id -> [attachment]
  tasks: [],              // 現在ルームのタスク
  hasMore: false,
  lastReadAtOpen: 0,
  replyTo: null,
  editingId: null,
  pendingFiles: [],
  panelTab: 'tasks',
  taskTab: 'mine',
  view: 'chat',
};

// ---------- 共通ユーティリティ ----------
function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => (t.hidden = true), 3000);
}
function fail(err) {
  console.error(err);
  toast(err?.message || String(err));
}
function nameOf(id) {
  return state.profiles.get(id)?.display_name || '（退会したユーザー）';
}
function avatarHtml(id, cls = '') {
  const name = state.profiles.get(id)?.display_name || '?';
  let h = 0;
  for (const c of String(id)) h = (h * 31 + c.charCodeAt(0)) % 360;
  return `<span class="avatar ${cls}" style="background:hsl(${h} 45% 48%)">${esc(name.trim().charAt(0))}</span>`;
}
function fmtTime(ts) {
  const d = new Date(ts);
  return d.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
}
function fmtDate(ts) {
  const d = new Date(ts);
  return d.toLocaleDateString('ja-JP', { year: 'numeric', month: 'long', day: 'numeric', weekday: 'short' });
}
function fmtSize(n) {
  if (n == null) return '';
  if (n < 1024) return `${n} B`;
  if (n < 1048576) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1048576).toFixed(1)} MB`;
}
function todayStr() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
function dueHtml(due, done) {
  if (!due) return '';
  const overdue = !done && due < todayStr();
  return `<span class="${overdue ? 'overdue' : ''}">期限 ${esc(due.replaceAll('-', '/'))}</span>`;
}
function storageGet(k, def) {
  try { return localStorage.getItem(k) ?? def; } catch { return def; }
}
function storageSet(k, v) {
  try { localStorage.setItem(k, v); } catch { /* 保存できない環境では無視 */ }
}

// メッセージ本文の表示用変換（必ずエスケープしてからタグを置換する）
function renderBody(body) {
  let html = esc(body);
  html = html.replace(/\[task\]([\s\S]*?)\[\/task\]/g, '');
  html = html.replace(/\[To:([0-9a-f-]{36})\]/g, '<span class="tag to">To</span>');
  html = html.replace(/\[toall\]/g, '<span class="tag toall">TO ALL</span>');
  html = html.replace(/(https?:\/\/[^\s<>"']+)/g, '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>');
  return html.trim();
}
function stripTags(body) {
  return String(body ?? '')
    .replace(/\[To:[0-9a-f-]{36}\]/g, '')
    .replace(/\[toall\]/g, '')
    .replace(/\[\/?task\]/g, '')
    .trim();
}
function isToMe(m) {
  if (!state.me || m.user_id === state.me.id) return false;
  if (m.body.includes(`[To:${state.me.id}]`) || m.body.includes('[toall]')) return true;
  if (m.reply_to) {
    const parent = state.messages.find((x) => x.id === m.reply_to);
    if (parent?.user_id === state.me.id) return true;
  }
  return false;
}

// ---------- ダイアログ ----------
function openDialog(html, onSubmit) {
  const dlg = $('#dialog');
  const form = $('#dialog-form');
  // Enter キーでの送信が「キャンセル」や「ログアウト」にならないよう、先頭に既定ボタンを置く
  form.innerHTML = (onSubmit ? '<button value="ok" tabindex="-1" aria-hidden="true" style="position:absolute;left:-9999px"></button>' : '') + html;
  form.onsubmit = async (e) => {
    const action = e.submitter?.value;
    if (action === 'cancel' || !onSubmit) return; // そのまま閉じる
    e.preventDefault();
    const btn = e.submitter;
    if (btn) btn.disabled = true;
    try {
      const keep = await onSubmit(new FormData(form), action);
      if (keep !== true) dlg.close();
    } catch (err) {
      fail(err);
    } finally {
      if (btn) btn.disabled = false;
    }
  };
  dlg.showModal();
  form.querySelector('[autofocus]')?.focus();
  return form;
}
function memberPickHtml(people, { checked = [], type = 'checkbox', name = 'members' } = {}) {
  return `<div class="pick-list">${people.map((p) => `
    <label><input type="${type}" name="${name}" value="${p.id}" ${checked.includes(p.id) ? 'checked' : ''}>
      ${avatarHtml(p.id, 'sm')} ${esc(p.display_name)}${p.title ? ` <small style="color:var(--muted)">${esc(p.title)}</small>` : ''}</label>`).join('')}</div>`;
}

// ---------- 認証 ----------
$('#auth-form').onsubmit = async (e) => {
  e.preventDefault();
  const f = new FormData(e.target);
  const msg = $('#auth-msg');
  msg.textContent = '';
  $('#auth-submit').disabled = true;
  try {
    const { error } = await sb.auth.signInWithPassword({ email: f.get('email').trim(), password: f.get('password') });
    if (error) throw error;
  } catch (err) {
    const m = err.message || '';
    msg.textContent =
      m.includes('Invalid login') ? 'メールアドレスまたはパスワードが違います' :
      m.includes('Email not confirmed') ? 'アカウントが有効化されていません。管理者へご連絡ください' : m;
  } finally {
    $('#auth-submit').disabled = false;
  }
};

let booted = false;
sb.auth.onAuthStateChange((event, session) => {
  if (session?.user) {
    if (!booted) {
      booted = true;
      // コールバック内で他の Supabase 呼び出しを待たないよう、処理を後ろに回す
      setTimeout(() => boot(session.user).catch(fail), 0);
    }
  } else {
    booted = false;
    teardown();
    $('#app-view').hidden = true;
    $('#auth-view').hidden = false;
  }
});

// ---------- 起動 ----------
let channel = null;
async function boot(user) {
  $('#auth-view').hidden = true;
  $('#app-view').hidden = false;
  await loadProfiles();
  state.me = state.profiles.get(user.id);
  if (!state.me) throw new Error('プロフィールが見つかりません');
  renderMe();
  subscribeRealtime();
  await refreshRooms();
  refreshMyTaskBadge();
  const fromHash = location.hash.match(/^#room=([0-9a-f-]{36})/)?.[1];
  const start = fromHash && state.rooms.some((r) => r.room_id === fromHash) ? fromHash : state.rooms[0]?.room_id;
  if (start && (window.innerWidth > 700 || fromHash)) await openRoom(start);
  else if (window.innerWidth <= 700) $('#sidebar').classList.add('open');
}
function teardown() {
  if (channel) sb.removeChannel(channel);
  channel = null;
  Object.assign(state, { me: null, rooms: [], currentRoomId: null, messages: [], tasks: [], members: [] });
}
async function loadProfiles() {
  const { data, error } = await sb.from('profiles').select('*').order('display_name');
  if (error) throw error;
  state.profiles = new Map(data.map((p) => [p.id, p]));
}
function renderMe() {
  $('#me-name').textContent = state.me.display_name;
  $('#me-avatar').outerHTML = `<span id="me-avatar">${avatarHtml(state.me.id, 'sm')}</span>`;
}

// ---------- リアルタイム ----------
function subscribeRealtime() {
  channel = sb.channel('chat-all')
    .on('postgres_changes', { event: '*', schema: 'public', table: 'messages' }, onMessageChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'message_reactions' }, onReactionChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'attachments' }, onAttachmentChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'tasks' }, onTaskChange)
    .on('postgres_changes', { event: '*', schema: 'public', table: 'room_members' }, onMemberChange)
    .subscribe();
}
const refreshRoomsSoon = debounce(() => refreshRooms().catch(fail), 300);
function debounce(fn, ms) {
  let t;
  return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); };
}

function onMessageChange({ eventType, new: row }) {
  if (eventType === 'INSERT') {
    if (row.room_id === state.currentRoomId && !state.messages.some((m) => m.id === row.id)) {
      const atBottom = isNearBottom();
      state.messages.push(row);
      renderMessages({ keepBottom: atBottom || row.user_id === state.me.id });
      if (document.visibilityState === 'visible' && state.view === 'chat') markRead();
    }
    if (row.user_id !== state.me.id) maybeNotify(row);
    refreshRoomsSoon();
  } else if (eventType === 'UPDATE') {
    const i = state.messages.findIndex((m) => m.id === row.id);
    if (i >= 0) {
      state.messages[i] = row;
      renderMessages({ preserve: true });
    }
    if (row.deleted_at) refreshRoomsSoon();
  }
}
function onReactionChange({ eventType, new: row, old }) {
  const r = eventType === 'DELETE' ? old : row;
  if (!state.messages.some((m) => m.id === r.message_id)) return;
  const list = state.reactions.get(r.message_id) || [];
  if (eventType === 'INSERT') {
    if (!list.some((x) => x.user_id === r.user_id && x.emoji === r.emoji)) list.push(r);
  } else if (eventType === 'DELETE') {
    const i = list.findIndex((x) => x.user_id === r.user_id && x.emoji === r.emoji);
    if (i >= 0) list.splice(i, 1);
  }
  state.reactions.set(r.message_id, list);
  renderMessages({ preserve: true });
}
function onAttachmentChange({ eventType, new: row }) {
  if (eventType !== 'INSERT' || row.room_id !== state.currentRoomId) return;
  const list = state.attachments.get(row.message_id) || [];
  if (!list.some((a) => a.id === row.id)) list.push(row);
  state.attachments.set(row.message_id, list);
  const atBottom = isNearBottom();
  renderMessages({ keepBottom: atBottom, preserve: !atBottom });
  if (state.panelTab === 'files') renderPanel();
}
function onTaskChange({ eventType, new: row, old }) {
  refreshMyTaskBadge();
  if (state.view === 'tasks') renderMyTasks();
  const roomId = eventType === 'DELETE' ? null : row.room_id;
  if (eventType === 'DELETE') {
    state.tasks = state.tasks.filter((t) => t.id !== old.id);
  } else if (roomId === state.currentRoomId) {
    const i = state.tasks.findIndex((t) => t.id === row.id);
    if (i >= 0) state.tasks[i] = row; else state.tasks.push(row);
  } else return;
  renderMessages({ preserve: true });
  renderPanel();
}
async function onMemberChange() {
  await loadProfiles().catch(fail);
  await refreshRooms().catch(fail);
  if (state.currentRoomId && !state.rooms.some((r) => r.room_id === state.currentRoomId)) {
    closeRoom();
    toast('チャットから退出しました');
  } else if (state.currentRoomId) {
    await loadMembers();
    renderRoomHeader();
    renderPanel();
  }
}

// デスクトップ通知
$('#notify-btn').onclick = async () => {
  if (!('Notification' in window)) return toast('このブラウザは通知に対応していません');
  const p = await Notification.requestPermission();
  toast(p === 'granted' ? 'Toや個人チャットのメッセージを通知します' : '通知はオフです（ブラウザの設定から許可できます）');
};
function maybeNotify(m) {
  if (!('Notification' in window) || Notification.permission !== 'granted') return;
  if (document.visibilityState === 'visible' && m.room_id === state.currentRoomId) return;
  const room = state.rooms.find((r) => r.room_id === m.room_id);
  const mine = m.body.includes(`[To:${state.me.id}]`) || m.body.includes('[toall]') || room?.is_direct;
  if (!mine) return;
  const n = new Notification(`${nameOf(m.user_id)}${room && !room.is_direct ? `（${room.name}）` : ''}`, {
    body: stripTags(m.body).slice(0, 120) || '（ファイル）',
    tag: `room-${m.room_id}`,
  });
  n.onclick = () => { window.focus(); showView('chat'); openRoom(m.room_id); n.close(); };
}

// ---------- ルーム一覧 ----------
async function refreshRooms() {
  const { data, error } = await sb.rpc('get_my_rooms');
  if (error) throw error;
  state.rooms = data;
  renderRooms();
  const unread = data.reduce((s, r) => s + Number(r.unread_count), 0);
  document.title = unread ? `(${unread}) ${APP_NAME}` : APP_NAME;
}
function renderRooms() {
  const q = $('#room-filter').value.trim().toLowerCase();
  const list = state.rooms.filter((r) => {
    if (q && !(r.name || '').toLowerCase().includes(q)) return false;
    if (state.roomFilter === 'unread') return r.unread_count > 0;
    if (state.roomFilter === 'mention') return r.mention_count > 0;
    return true;
  });
  $('#room-list').innerHTML = list.length ? list.map((r) => `
    <li class="room-item ${r.room_id === state.currentRoomId ? 'active' : ''} ${r.unread_count > 0 ? 'unread' : ''}" data-room="${r.room_id}">
      ${r.is_direct && r.other_user_id ? avatarHtml(r.other_user_id) : `<span class="avatar" style="background:#5b6472">${r.is_direct ? '自' : '#'}</span>`}
      <span class="room-name">${esc(r.name)}</span>
      ${r.mention_count > 0 ? `<span class="badge to">${r.mention_count}</span>` : r.unread_count > 0 ? `<span class="badge">${r.unread_count}</span>` : ''}
    </li>`).join('') : '<li class="empty-state">該当するチャットはありません</li>';
}
$('#room-list').onclick = (e) => {
  const li = e.target.closest('[data-room]');
  if (li) openRoom(li.dataset.room);
};
$('#room-filter').oninput = renderRooms;
document.querySelectorAll('[data-filter]').forEach((b) => (b.onclick = () => {
  state.roomFilter = b.dataset.filter;
  document.querySelectorAll('[data-filter]').forEach((x) => x.classList.toggle('active', x === b));
  renderRooms();
}));
$('#toggle-sidebar').onclick = () => $('#sidebar').classList.toggle('open');

// ---------- ルームを開く ----------
async function openRoom(roomId) {
  showView('chat');
  $('#sidebar').classList.remove('open');
  const room = state.rooms.find((r) => r.room_id === roomId);
  if (!room) return;
  state.currentRoomId = roomId;
  state.lastReadAtOpen = Number(room.last_read_message_id);
  state.messages = [];
  state.reactions = new Map();
  state.attachments = new Map();
  state.tasks = [];
  cancelContext();
  history.replaceState(null, '', `#room=${roomId}`);
  $('#no-room').hidden = true;
  $('#chat-inner').hidden = false;
  $('#messages').innerHTML = '';
  renderRooms();
  try {
    await Promise.all([loadMembers(), loadMessages(), loadTasks()]);
    if (state.currentRoomId !== roomId) return;
    renderRoomHeader();
    renderMessages({ scrollToUnread: true });
    renderPanel();
    markRead();
    if (window.innerWidth > 700) $('#message-input').focus();
  } catch (err) { fail(err); }
}
function closeRoom() {
  state.currentRoomId = null;
  $('#no-room').hidden = false;
  $('#chat-inner').hidden = true;
  $('#panel').hidden = true;
  history.replaceState(null, '', location.pathname);
  renderRooms();
}
function currentRoom() {
  return state.rooms.find((r) => r.room_id === state.currentRoomId);
}
async function loadMembers() {
  const { data, error } = await sb.from('room_members').select('*').eq('room_id', state.currentRoomId);
  if (error) throw error;
  state.members = data.sort((a, b) => nameOf(a.user_id).localeCompare(nameOf(b.user_id), 'ja'));
}
async function loadMessages(beforeId) {
  let q = sb.from('messages').select('*').eq('room_id', state.currentRoomId).order('id', { ascending: false }).limit(PAGE_SIZE);
  if (beforeId) q = q.lt('id', beforeId);
  const { data, error } = await q;
  if (error) throw error;
  const rows = data.reverse();
  state.hasMore = data.length === PAGE_SIZE;
  state.messages = beforeId ? [...rows, ...state.messages] : rows;
  await loadExtras(rows.map((m) => m.id));
}
async function loadExtras(ids) {
  if (!ids.length) return;
  const [rx, at] = await Promise.all([
    sb.from('message_reactions').select('message_id,user_id,emoji').in('message_id', ids),
    sb.from('attachments').select('*').in('message_id', ids),
  ]);
  if (rx.error) throw rx.error;
  if (at.error) throw at.error;
  for (const r of rx.data) state.reactions.set(r.message_id, [...(state.reactions.get(r.message_id) || []), r]);
  for (const a of at.data) state.attachments.set(a.message_id, [...(state.attachments.get(a.message_id) || []), a]);
}
async function loadTasks() {
  const { data, error } = await sb.from('tasks').select('*').eq('room_id', state.currentRoomId).order('created_at', { ascending: false });
  if (error) throw error;
  state.tasks = data;
}
$('#load-more').onclick = async () => {
  const tl = $('#timeline');
  const prevHeight = tl.scrollHeight;
  try {
    await loadMessages(state.messages[0]?.id);
    renderMessages();
    tl.scrollTop = tl.scrollHeight - prevHeight;
  } catch (err) { fail(err); }
};
async function markRead() {
  const last = state.messages.at(-1);
  const room = currentRoom();
  if (!last || !room || Number(room.last_read_message_id) >= last.id) return;
  room.last_read_message_id = last.id;
  room.unread_count = 0;
  room.mention_count = 0;
  renderRooms();
  const { error } = await sb.rpc('mark_room_read', { p_room: state.currentRoomId, p_message_id: last.id });
  if (error) fail(error);
  refreshRoomsSoon();
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && state.currentRoomId && state.view === 'chat') markRead();
});

function renderRoomHeader() {
  const room = currentRoom();
  if (!room) return;
  $('#chat-title').textContent = room.name;
  $('#chat-sub').textContent = room.is_direct ? '個人チャット' : `${state.members.length}人のメンバー${room.description ? ' ・ ' + room.description : ''}`;
}

// ---------- メッセージ表示 ----------
function isNearBottom() {
  const tl = $('#timeline');
  return tl.scrollHeight - tl.scrollTop - tl.clientHeight < 80;
}
function renderMessages({ keepBottom = false, scrollToUnread = false, preserve = false } = {}) {
  const tl = $('#timeline');
  const prevTop = tl.scrollTop;
  $('#load-more').hidden = !state.hasMore;
  let html = '';
  let lastDate = '';
  let unreadMarked = false;
  for (const m of state.messages) {
    if (m.deleted_at) continue;
    const d = fmtDate(m.created_at);
    if (d !== lastDate) { html += `<div class="date-sep"><span>${d}</span></div>`; lastDate = d; }
    if (!unreadMarked && state.lastReadAtOpen && m.id > state.lastReadAtOpen && m.user_id !== state.me.id) {
      html += '<div class="unread-sep" id="unread-sep">ここから未読</div>';
      unreadMarked = true;
    }
    html += messageHtml(m);
  }
  $('#messages').innerHTML = html || '<div class="empty-state">まだメッセージはありません</div>';
  fillAttachmentUrls();
  if (scrollToUnread && $('#unread-sep')) $('#unread-sep').scrollIntoView({ block: 'center' });
  else if (keepBottom || scrollToUnread) tl.scrollTop = tl.scrollHeight;
  else if (preserve) tl.scrollTop = prevTop;
}
function messageHtml(m) {
  const mine = m.user_id === state.me.id;
  const parent = m.reply_to ? state.messages.find((x) => x.id === m.reply_to) : null;
  const rx = state.reactions.get(m.id) || [];
  const grouped = REACTIONS.map((e) => [e, rx.filter((r) => r.emoji === e)]).filter(([, l]) => l.length);
  const taskMatch = m.body.match(/\[task\]([\s\S]*?)\[\/task\]/);
  const tasks = taskMatch ? state.tasks.filter((t) => t.message_id === m.id) : [];
  const files = state.attachments.get(m.id) || [];
  return `
  <div class="msg ${isToMe(m) ? 'to-me' : ''}" id="msg-${m.id}" data-id="${m.id}">
    ${avatarHtml(m.user_id)}
    <div class="msg-main">
      <div class="msg-head">
        <span class="msg-name">${esc(nameOf(m.user_id))}</span>
        <span class="msg-time">${fmtTime(m.created_at)}${m.edited_at ? '（編集済み）' : ''}</span>
      </div>
      ${m.reply_to ? `<div class="reply-quote" data-jump="${m.reply_to}"><span class="tag re">RE</span>${parent ? `${esc(nameOf(parent.user_id))}：${esc(stripTags(parent.body).slice(0, 80))}` : '以前のメッセージ'}</div>` : ''}
      <div class="msg-body">${renderBody(m.body)}</div>
      ${taskMatch ? taskBlockHtml(taskMatch[1], tasks) : ''}
      ${files.length ? `<div class="attachments">${files.map(attachmentHtml).join('')}</div>` : ''}
      ${grouped.length ? `<div class="reactions">${grouped.map(([e, l]) => `
        <button class="reaction ${l.some((r) => r.user_id === state.me.id) ? 'mine' : ''}" data-react="${e}" title="${esc(l.map((r) => nameOf(r.user_id)).join('、'))}">${e} ${l.length}</button>`).join('')}</div>` : ''}
    </div>
    <div class="msg-actions">
      <span class="reaction-picker">${REACTIONS.map((e) => `<button data-react="${e}" title="リアクション">${e}</button>`).join('')}</span>
      <button data-act="reply">返信</button>
      <button data-act="quote">引用</button>
      <button data-act="task">タスク化</button>
      ${mine ? '<button data-act="edit">編集</button><button data-act="delete">削除</button>' : ''}
    </div>
  </div>`;
}
function taskBlockHtml(text, tasks) {
  const allDone = tasks.length && tasks.every((t) => t.done);
  const t0 = tasks[0];
  return `<div class="task-block ${allDone ? 'done' : ''}">
    <div class="task-text">✔ ${esc(text)}</div>
    <div class="task-meta">担当：${tasks.length ? tasks.map((t) => `${esc(nameOf(t.assignee_id))}${t.done ? '（完了）' : ''}`).join('、') : '—'}
      ${t0?.due_date ? ' ・ ' + dueHtml(t0.due_date, allDone) : ''}</div>
  </div>`;
}
function attachmentHtml(a) {
  const isImg = (a.mime_type || '').startsWith('image/');
  if (isImg) return `<a class="file-link" data-path="${esc(a.storage_path)}" data-img="1"><img class="img-preview" alt="${esc(a.file_name)}" data-path="${esc(a.storage_path)}"></a>`;
  return `<a class="file-card file-link" data-path="${esc(a.storage_path)}" data-name="${esc(a.file_name)}" target="_blank" rel="noopener">
    📄 <span class="fname">${esc(a.file_name)}</span><span class="fsize">${fmtSize(a.size_bytes)}</span></a>`;
}

// 添付ファイルは非公開なので、表示時に期限付きURLを発行する
const signedUrls = new Map(); // path -> {url, exp}
async function signedUrl(path) {
  const c = signedUrls.get(path);
  if (c && c.exp > Date.now()) return c.url;
  const { data, error } = await sb.storage.from('attachments').createSignedUrl(path, 3600);
  if (error) throw error;
  signedUrls.set(path, { url: data.signedUrl, exp: Date.now() + 3500 * 1000 });
  return data.signedUrl;
}
function fillAttachmentUrls() {
  document.querySelectorAll('#messages img[data-path], #panel-body img[data-path]').forEach(async (img) => {
    try {
      const wasBottom = isNearBottom();
      img.src = await signedUrl(img.dataset.path);
      img.onload = () => { if (wasBottom) $('#timeline').scrollTop = $('#timeline').scrollHeight; };
    } catch (err) { console.error(err); }
  });
}
async function openAttachment(el) {
  try {
    const url = await signedUrl(el.dataset.path);
    if (el.dataset.img) {
      openDialog(`<img class="img-full" src="${esc(url)}" alt="">
        <div class="dialog-actions"><a class="btn" href="${esc(url)}" target="_blank" rel="noopener">新しいタブで開く</a><button class="btn primary" value="cancel">閉じる</button></div>`);
    } else {
      window.open(url, '_blank', 'noopener');
    }
  } catch (err) { fail(err); }
}

// メッセージ上の操作
$('#messages').addEventListener('click', async (e) => {
  const file = e.target.closest('.file-link');
  if (file) { e.preventDefault(); return openAttachment(file); }
  const jump = e.target.closest('[data-jump]');
  if (jump) return jumpTo(Number(jump.dataset.jump));
  const msgEl = e.target.closest('.msg');
  if (!msgEl) return;
  const id = Number(msgEl.dataset.id);
  const m = state.messages.find((x) => x.id === id);
  const react = e.target.closest('[data-react]');
  if (react) return toggleReaction(m, react.dataset.react);
  const act = e.target.closest('[data-act]')?.dataset.act;
  if (!act) {
    // スマホではタップで操作メニューを出す
    if (window.matchMedia('(hover: none)').matches) {
      document.querySelectorAll('.msg.show-actions').forEach((x) => x !== msgEl && x.classList.remove('show-actions'));
      msgEl.classList.toggle('show-actions');
    }
    return;
  }
  if (act === 'reply') startReply(m);
  if (act === 'quote') insertText(`「${nameOf(m.user_id)}さんのメッセージ」\n> ${stripTags(m.body).split('\n').join('\n> ')}\n`);
  if (act === 'task') openTaskDialog(stripTags(m.body));
  if (act === 'edit') startEdit(m);
  if (act === 'delete') deleteMessage(m);
});
function jumpTo(id) {
  const el = $(`#msg-${id}`);
  if (!el) return toast('元のメッセージはこの画面より前にあります');
  el.scrollIntoView({ block: 'center', behavior: 'smooth' });
  el.classList.remove('highlight');
  void el.offsetWidth;
  el.classList.add('highlight');
}
async function toggleReaction(m, emoji) {
  const mine = (state.reactions.get(m.id) || []).some((r) => r.user_id === state.me.id && r.emoji === emoji);
  const q = mine
    ? sb.from('message_reactions').delete().match({ message_id: m.id, user_id: state.me.id, emoji })
    : sb.from('message_reactions').insert({ message_id: m.id, user_id: state.me.id, room_id: m.room_id, emoji });
  const { error } = await q;
  if (error) return fail(error);
  // 自分の操作はすぐ画面に反映（リアルタイム通知と重複しても問題ないようにしてある）
  onReactionChange(mine
    ? { eventType: 'DELETE', old: { message_id: m.id, user_id: state.me.id, emoji } }
    : { eventType: 'INSERT', new: { message_id: m.id, user_id: state.me.id, emoji } });
}
async function deleteMessage(m) {
  if (!confirm('このメッセージを削除しますか？')) return;
  const { error } = await sb.from('messages').update({ deleted_at: new Date().toISOString() }).eq('id', m.id);
  if (error) return fail(error);
  m.deleted_at = new Date().toISOString();
  renderMessages({ preserve: true });
}

// ---------- 入力欄 ----------
const input = $('#message-input');
$('#enter-send').checked = storageGet('enterSend', '0') === '1';
function updatePlaceholder() {
  input.placeholder = $('#enter-send').checked ? 'メッセージを入力（Enterで送信、Shift+Enterで改行）' : 'メッセージを入力（Ctrl+Enterで送信）';
}
updatePlaceholder();
$('#enter-send').onchange = (e) => { storageSet('enterSend', e.target.checked ? '1' : '0'); updatePlaceholder(); };
input.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter' || e.isComposing) return;
  const enterSend = $('#enter-send').checked;
  if ((e.ctrlKey || e.metaKey) || (enterSend && !e.shiftKey)) {
    e.preventDefault();
    send();
  }
});
input.addEventListener('paste', (e) => {
  const files = [...(e.clipboardData?.files || [])];
  if (files.length) { e.preventDefault(); addPendingFiles(files); }
});
$('#send-btn').onclick = send;
$('#cancel-context').onclick = cancelContext;

function insertText(text) {
  const s = input.selectionStart;
  input.value = input.value.slice(0, s) + text + input.value.slice(input.selectionEnd);
  input.focus();
  input.selectionStart = input.selectionEnd = s + text.length;
}
function setContext(text) {
  $('#composer-context-text').textContent = text;
  $('#composer-context').hidden = false;
}
function cancelContext() {
  const wasEditing = state.editingId != null;
  state.replyTo = null;
  state.editingId = null;
  $('#composer-context').hidden = true;
  $('#send-btn').textContent = '送信';
  if (wasEditing) input.value = '';
}
function startReply(m) {
  state.editingId = null;
  state.replyTo = m.id;
  setContext(`返信：${nameOf(m.user_id)}「${stripTags(m.body).slice(0, 40)}」`);
  $('#send-btn').textContent = '送信';
  input.focus();
}
function startEdit(m) {
  state.replyTo = null;
  state.editingId = m.id;
  input.value = m.body;
  setContext('メッセージを編集中');
  $('#send-btn').textContent = '更新';
  input.focus();
}

$('#to-btn').onclick = () => {
  const others = state.members.filter((x) => x.user_id !== state.me.id).map((x) => state.profiles.get(x.user_id)).filter(Boolean);
  const room = currentRoom();
  openDialog(`<h3>宛先を選択</h3>
    ${room && !room.is_direct ? '<div class="pick-list" style="margin-bottom:8px"><label><input type="checkbox" name="all" value="1"> <span class="tag toall">TO ALL</span> 全員</label></div>' : ''}
    ${memberPickHtml(others)}
    <div class="dialog-actions"><button class="btn" value="cancel">キャンセル</button><button class="btn primary" value="ok">挿入</button></div>`,
  (fd) => {
    let text = fd.get('all') ? '[toall]\n' : '';
    for (const id of fd.getAll('members')) text += `[To:${id}]${nameOf(id)}さん\n`;
    if (text) insertText(text);
  });
};

// 添付
$('#attach-btn').onclick = () => $('#file-input').click();
$('#file-input').onchange = (e) => { addPendingFiles([...e.target.files]); e.target.value = ''; };
const tl = $('#timeline');
tl.addEventListener('dragover', (e) => { if (e.dataTransfer?.types.includes('Files')) { e.preventDefault(); tl.classList.add('dragover'); } });
tl.addEventListener('dragleave', (e) => { if (e.target === tl) tl.classList.remove('dragover'); });
tl.addEventListener('drop', (e) => {
  e.preventDefault();
  tl.classList.remove('dragover');
  addPendingFiles([...(e.dataTransfer?.files || [])]);
});
function addPendingFiles(files) {
  if (!state.currentRoomId) return;
  for (const f of files) {
    if (f.size > 50 * 1024 * 1024) { toast(`${f.name} は50MBを超えているため添付できません`); continue; }
    state.pendingFiles.push(f);
  }
  renderPendingFiles();
  input.focus();
}
function renderPendingFiles() {
  $('#pending-files').innerHTML = state.pendingFiles.map((f, i) => `
    <span class="pending-file">📎 ${esc(f.name)} <button class="link" data-remove="${i}" title="外す">×</button></span>`).join('');
}
$('#pending-files').onclick = (e) => {
  const i = e.target.dataset.remove;
  if (i != null) { state.pendingFiles.splice(Number(i), 1); renderPendingFiles(); }
};

let sending = false;
async function send() {
  if (sending || !state.currentRoomId) return;
  const body = input.value.trim();
  const files = state.pendingFiles;
  if (!body && !files.length) return;
  sending = true;
  $('#send-btn').disabled = true;
  try {
    if (state.editingId) {
      const { error } = await sb.from('messages').update({ body, edited_at: new Date().toISOString() }).eq('id', state.editingId);
      if (error) throw error;
      const m = state.messages.find((x) => x.id === state.editingId);
      if (m) { m.body = body; m.edited_at = new Date().toISOString(); }
      input.value = '';
      cancelContext();
      renderMessages({ preserve: true });
      return;
    }
    const msg = await postMessage(body, state.replyTo);
    if (files.length) await uploadFiles(msg, files);
    input.value = '';
    state.pendingFiles = [];
    renderPendingFiles();
    cancelContext();
  } catch (err) {
    fail(err);
  } finally {
    sending = false;
    $('#send-btn').disabled = false;
  }
}
async function postMessage(body, replyTo = null) {
  const { data, error } = await sb.from('messages')
    .insert({ room_id: state.currentRoomId, user_id: state.me.id, body, reply_to: replyTo })
    .select().single();
  if (error) throw error;
  // リアルタイム通知を待たずに表示
  onMessageChange({ eventType: 'INSERT', new: data });
  return data;
}
async function uploadFiles(msg, files) {
  for (const f of files) {
    const safeName = f.name.replace(/[^\w.\-]+/g, '_').slice(-80) || 'file';
    const path = `${msg.room_id}/${crypto.randomUUID()}/${safeName}`;
    const up = await sb.storage.from('attachments').upload(path, f, { contentType: f.type || 'application/octet-stream' });
    if (up.error) throw up.error;
    const { data, error } = await sb.from('attachments').insert({
      message_id: msg.id, room_id: msg.room_id, storage_path: path, file_name: f.name,
      mime_type: f.type || null, size_bytes: f.size, uploaded_by: state.me.id,
    }).select().single();
    if (error) throw error;
    onAttachmentChange({ eventType: 'INSERT', new: data });
  }
}

// ---------- タスク ----------
$('#task-btn').onclick = () => openTaskDialog(input.value.trim());
function openTaskDialog(text = '') {
  const people = state.members.map((x) => state.profiles.get(x.user_id)).filter(Boolean);
  openDialog(`<h3>タスクを追加</h3>
    <label class="field">内容<textarea name="body" rows="3" required autofocus>${esc(text)}</textarea></label>
    <label class="field">担当者（複数可）${memberPickHtml(people, { checked: [state.me.id] })}</label>
    <label class="field">期限<input type="date" name="due"></label>
    <div class="dialog-actions"><button class="btn" value="cancel">キャンセル</button><button class="btn primary" value="ok">追加</button></div>`,
  async (fd) => {
    const body = fd.get('body').trim();
    const assignees = fd.getAll('members');
    if (!body) throw new Error('内容を入力してください');
    if (!assignees.length) throw new Error('担当者を選んでください');
    const due = fd.get('due') || null;
    const msgBody = assignees.filter((id) => id !== state.me.id).map((id) => `[To:${id}]${nameOf(id)}さん\n`).join('') + `[task]${body}[/task]`;
    const msg = await postMessage(msgBody);
    const { data, error } = await sb.from('tasks').insert(assignees.map((id) => ({
      room_id: state.currentRoomId, message_id: msg.id, body, assignee_id: id, created_by: state.me.id, due_date: due,
    }))).select();
    if (error) throw error;
    for (const t of data) onTaskChange({ eventType: 'INSERT', new: t });
    if (input.value.trim() === text) input.value = '';
  });
}
async function setTaskDone(id, done) {
  const { data, error } = await sb.from('tasks').update({ done, done_at: done ? new Date().toISOString() : null }).eq('id', id).select().single();
  if (error) return fail(error);
  onTaskChange({ eventType: 'UPDATE', new: data });
}
function taskItemHtml(t, { showRoom = false } = {}) {
  const canEdit = t.assignee_id === state.me.id || t.created_by === state.me.id;
  const roomName = showRoom ? (t.rooms?.is_direct ? '個人チャット' : t.rooms?.name) : null;
  return `<li class="task-item ${t.done ? 'done' : ''}">
    <input type="checkbox" data-task="${t.id}" ${t.done ? 'checked' : ''} ${canEdit ? '' : 'disabled'} title="${t.done ? '未完了に戻す' : '完了にする'}">
    <div class="grow">
      <div class="task-text">${esc(t.body)}</div>
      <div class="task-meta">担当：${esc(nameOf(t.assignee_id))} ・ 依頼：${esc(nameOf(t.created_by))}
        ${t.due_date ? ' ・ ' + dueHtml(t.due_date, t.done) : ''}
        ${roomName ? ` ・ <button class="link" data-goto-room="${t.room_id}" data-goto-msg="${t.message_id ?? ''}">${esc(roomName)}</button>` : ''}
        ${!showRoom && t.message_id ? ` ・ <button class="link" data-jump="${t.message_id}">元のメッセージ</button>` : ''}
        ${t.created_by === state.me.id ? ` ・ <button class="link" data-del-task="${t.id}">削除</button>` : ''}
      </div>
    </div></li>`;
}
async function deleteTask(id) {
  if (!confirm('このタスクを削除しますか？')) return;
  const { error } = await sb.from('tasks').delete().eq('id', id);
  if (error) return fail(error);
  onTaskChange({ eventType: 'DELETE', old: { id } });
}
async function refreshMyTaskBadge() {
  const { count, error } = await sb.from('tasks').select('id', { count: 'exact', head: true })
    .eq('assignee_id', state.me.id).eq('done', false);
  if (error) return;
  $('#mytask-badge').hidden = !count;
  $('#mytask-badge').textContent = count;
}
async function renderMyTasks() {
  let q = sb.from('tasks').select('*, rooms(name,is_direct)');
  if (state.taskTab === 'mine') q = q.eq('assignee_id', state.me.id).eq('done', false).order('due_date', { ascending: true, nullsFirst: false });
  if (state.taskTab === 'requested') q = q.eq('created_by', state.me.id).neq('assignee_id', state.me.id).eq('done', false).order('due_date', { ascending: true, nullsFirst: false });
  if (state.taskTab === 'done') q = q.eq('assignee_id', state.me.id).eq('done', true).order('done_at', { ascending: false }).limit(100);
  const { data, error } = await q;
  if (error) return fail(error);
  // 個人チャットは相手の名前で表示する
  for (const t of data) {
    const r = state.rooms.find((x) => x.room_id === t.room_id);
    if (r && t.rooms) t.rooms = { ...t.rooms, name: r.name, is_direct: false };
  }
  $('#mytask-list').innerHTML = data.length ? data.map((t) => taskItemHtml(t, { showRoom: true })).join('') : '<li class="empty-state">タスクはありません</li>';
}
document.querySelectorAll('[data-tasktab]').forEach((b) => (b.onclick = () => {
  state.taskTab = b.dataset.tasktab;
  document.querySelectorAll('[data-tasktab]').forEach((x) => x.classList.toggle('active', x === b));
  renderMyTasks();
}));
document.addEventListener('change', (e) => {
  const id = e.target.dataset?.task;
  if (id) setTaskDone(id, e.target.checked);
});
document.addEventListener('click', async (e) => {
  const del = e.target.closest('[data-del-task]');
  if (del) return deleteTask(del.dataset.delTask);
  const go = e.target.closest('[data-goto-room]');
  if (go) {
    await openRoom(go.dataset.gotoRoom);
    if (go.dataset.gotoMsg) setTimeout(() => jumpTo(Number(go.dataset.gotoMsg)), 50);
  }
});

// ---------- 右パネル ----------
$('#toggle-panel').onclick = () => { $('#panel').hidden = !$('#panel').hidden; renderPanel(); };
document.querySelectorAll('[data-panel]').forEach((b) => (b.onclick = () => {
  state.panelTab = b.dataset.panel;
  document.querySelectorAll('[data-panel]').forEach((x) => x.classList.toggle('active', x === b));
  renderPanel();
}));
async function renderPanel() {
  if ($('#panel').hidden || !state.currentRoomId) return;
  const body = $('#panel-body');
  const room = currentRoom();
  if (state.panelTab === 'tasks') {
    const open = state.tasks.filter((t) => !t.done);
    const done = state.tasks.filter((t) => t.done);
    body.innerHTML = `<button class="btn primary sm" id="panel-add-task">＋ タスクを追加</button>
      <h3 style="margin-top:14px">未完了（${open.length}）</h3>
      <ul class="task-list">${open.map((t) => taskItemHtml(t)).join('') || '<li class="task-meta">なし</li>'}</ul>
      <h3>完了（${done.length}）</h3>
      <ul class="task-list">${done.slice(0, 30).map((t) => taskItemHtml(t)).join('') || '<li class="task-meta">なし</li>'}</ul>`;
    $('#panel-add-task').onclick = () => openTaskDialog();
  } else if (state.panelTab === 'files') {
    const { data, error } = await sb.from('attachments').select('*').eq('room_id', state.currentRoomId).order('created_at', { ascending: false }).limit(100);
    if (error) return fail(error);
    if (state.panelTab !== 'files') return;
    body.innerHTML = data.length ? data.map((a) => `
      <div class="member-row">
        <a class="file-card file-link grow" data-path="${esc(a.storage_path)}" ${(a.mime_type || '').startsWith('image/') ? 'data-img="1"' : ''}>
          ${(a.mime_type || '').startsWith('image/') ? '🖼' : '📄'} <span class="fname">${esc(a.file_name)}</span><span class="fsize">${fmtSize(a.size_bytes)}</span></a>
      </div>
      <div class="task-meta" style="margin:-2px 0 8px">${esc(nameOf(a.uploaded_by))} ・ ${new Date(a.created_at).toLocaleString('ja-JP')}</div>`).join('')
      : '<p class="task-meta">共有されたファイルはありません</p>';
  } else {
    const amAdmin = room.role === 'admin';
    body.innerHTML = `
      <h3>チャット名</h3><div>${esc(room.name)}</div>
      ${room.description ? `<h3>概要</h3><div style="white-space:pre-wrap">${esc(room.description)}</div>` : ''}
      <h3>メンバー（${state.members.length}）</h3>
      ${state.members.map((mb) => `<div class="member-row">${avatarHtml(mb.user_id, 'sm')}
        <span class="grow">${esc(nameOf(mb.user_id))}</span>
        ${mb.role === 'admin' && !room.is_direct ? '<span class="role">管理者</span>' : ''}
        ${amAdmin && !room.is_direct && mb.user_id !== state.me.id ? `<button class="link" data-kick="${mb.user_id}">外す</button>` : ''}
      </div>`).join('')}
      ${!room.is_direct ? `<div class="dialog-actions" style="justify-content:flex-start;flex-wrap:wrap">
        ${amAdmin ? '<button class="btn sm" id="edit-room">名前・概要を編集</button><button class="btn sm" id="add-members">メンバー追加</button>' : ''}
        <button class="btn sm danger" id="leave-room">退出する</button></div>` : ''}`;
    $('#edit-room')?.addEventListener('click', editRoom);
    $('#add-members')?.addEventListener('click', addMembers);
    $('#leave-room')?.addEventListener('click', () => removeMember(state.me.id, true));
    body.querySelectorAll('[data-kick]').forEach((b) => (b.onclick = () => removeMember(b.dataset.kick)));
  }
  fillAttachmentUrls();
}
$('#panel-body').addEventListener('click', (e) => {
  const file = e.target.closest('.file-link');
  if (file) { e.preventDefault(); openAttachment(file); return; }
  const jump = e.target.closest('[data-jump]');
  if (jump) jumpTo(Number(jump.dataset.jump));
});
function editRoom() {
  const room = currentRoom();
  openDialog(`<h3>チャットを編集</h3>
    <label class="field">チャット名<input name="name" required value="${esc(room.name)}" autofocus></label>
    <label class="field">概要<textarea name="description" rows="3">${esc(room.description || '')}</textarea></label>
    <div class="dialog-actions"><button class="btn" value="cancel">キャンセル</button><button class="btn primary" value="ok">保存</button></div>`,
  async (fd) => {
    const { error } = await sb.from('rooms').update({ name: fd.get('name').trim(), description: fd.get('description').trim() || null }).eq('id', room.room_id);
    if (error) throw error;
    await refreshRooms();
    renderRoomHeader();
    renderPanel();
  });
}
function addMembers() {
  const inRoom = new Set(state.members.map((m) => m.user_id));
  const candidates = [...state.profiles.values()].filter((p) => !inRoom.has(p.id));
  if (!candidates.length) return toast('追加できるメンバーはいません');
  openDialog(`<h3>メンバーを追加</h3>${memberPickHtml(candidates)}
    <div class="dialog-actions"><button class="btn" value="cancel">キャンセル</button><button class="btn primary" value="ok">追加</button></div>`,
  async (fd) => {
    const ids = fd.getAll('members');
    if (!ids.length) return;
    const { error } = await sb.rpc('add_room_members', { p_room: state.currentRoomId, p_member_ids: ids });
    if (error) throw error;
    await loadMembers();
    renderRoomHeader();
    renderPanel();
  });
}
async function removeMember(userId, self = false) {
  if (!confirm(self ? 'このチャットから退出しますか？' : `${nameOf(userId)}さんをこのチャットから外しますか？`)) return;
  if (self && currentRoom().role === 'admin' && !state.members.some((m) => m.role === 'admin' && m.user_id !== state.me.id) && state.members.length > 1) {
    return toast('管理者があなただけのため退出できません');
  }
  const { error } = await sb.from('room_members').delete().match({ room_id: state.currentRoomId, user_id: userId });
  if (error) return fail(error);
  if (self) { await refreshRooms(); closeRoom(); } else { await loadMembers(); renderRoomHeader(); renderPanel(); }
}

// ---------- 新しいチャット ----------
$('#new-room-btn').onclick = () => {
  const others = [...state.profiles.values()].filter((p) => p.id !== state.me.id);
  openDialog(`<h3>グループチャットを作成</h3>
    <label class="field">チャット名<input name="name" required autofocus placeholder="例：営業部"></label>
    <label class="field">概要（任意）<textarea name="description" rows="2"></textarea></label>
    <label class="field">メンバー${others.length ? memberPickHtml(others) : '<div class="task-meta">まだ他のメンバーがいません</div>'}</label>
    <p class="task-meta">個人チャットは上の「メンバー」から相手を選んで始められます。</p>
    <div class="dialog-actions"><button class="btn" value="cancel">キャンセル</button><button class="btn primary" value="ok">作成</button></div>`,
  async (fd) => {
    const { data, error } = await sb.rpc('create_group_room', {
      p_name: fd.get('name').trim(), p_description: fd.get('description').trim() || null, p_member_ids: fd.getAll('members'),
    });
    if (error) throw error;
    await refreshRooms();
    await openRoom(data);
  });
};

// ---------- メンバー（コンタクト） ----------
function renderContacts() {
  const q = $('#contact-filter').value.trim().toLowerCase();
  const people = [...state.profiles.values()].filter((p) =>
    !q || p.display_name.toLowerCase().includes(q) || p.email.toLowerCase().includes(q) || (p.title || '').toLowerCase().includes(q));
  $('#contact-list').innerHTML = people.map((p) => `
    <li class="contact">${avatarHtml(p.id)}
      <div class="grow"><div>${esc(p.display_name)}${p.id === state.me.id ? '（自分）' : ''}</div>
        <div class="sub">${esc(p.title || '')}${p.title ? ' ・ ' : ''}${esc(p.email)}</div></div>
      <button class="btn sm" data-dm="${p.id}">${p.id === state.me.id ? 'マイチャット' : 'チャット'}</button>
    </li>`).join('');
}
$('#contact-filter').oninput = renderContacts;
$('#contact-list').onclick = async (e) => {
  const b = e.target.closest('[data-dm]');
  if (!b) return;
  const { data, error } = await sb.rpc('get_or_create_direct_room', { p_other: b.dataset.dm });
  if (error) return fail(error);
  await refreshRooms();
  await openRoom(data);
};

// ---------- 画面切替・プロフィール ----------
function showView(v) {
  state.view = v;
  $('#nav-chat').classList.toggle('active', v === 'chat');
  $('#nav-tasks').classList.toggle('active', v === 'tasks');
  $('#nav-contacts').classList.toggle('active', v === 'contacts');
  $('#chat-view').hidden = v !== 'chat';
  $('#tasks-view').hidden = v !== 'tasks';
  $('#contacts-view').hidden = v !== 'contacts';
  if (v !== 'chat') $('#panel').hidden = true;
  if (v === 'tasks') renderMyTasks();
  if (v === 'contacts') renderContacts();
}
$('#nav-chat').onclick = () => { showView('chat'); if (window.innerWidth <= 700) $('#sidebar').classList.add('open'); };
$('#nav-tasks').onclick = () => { showView('tasks'); $('#sidebar').classList.remove('open'); };
$('#nav-contacts').onclick = () => { showView('contacts'); $('#sidebar').classList.remove('open'); };

$('#me-btn').onclick = () => {
  openDialog(`<h3>プロフィール</h3>
    <label class="field">表示名<input name="display_name" required value="${esc(state.me.display_name)}" autofocus></label>
    <label class="field">部署・役職（任意）<input name="title" value="${esc(state.me.title || '')}" placeholder="例：営業部 課長"></label>
    <label class="field">メールアドレス<input value="${esc(state.me.email)}" disabled></label>
    <label class="field">新しいパスワード（変更する場合のみ）<input name="password" type="password" minlength="8" autocomplete="new-password"></label>
    <div class="dialog-actions" style="justify-content:space-between">
      <button class="btn danger" value="logout">ログアウト</button>
      <span><button class="btn" value="cancel">キャンセル</button> <button class="btn primary" value="ok">保存</button></span>
    </div>`,
  async (fd, action) => {
    if (action === 'logout') { await sb.auth.signOut(); return; }
    const display_name = fd.get('display_name').trim();
    if (!display_name) throw new Error('表示名を入力してください');
    const { data, error } = await sb.from('profiles').update({ display_name, title: fd.get('title').trim() || null })
      .eq('id', state.me.id).select().single();
    if (error) throw error;
    const pw = fd.get('password');
    if (pw) {
      const { error: e2 } = await sb.auth.updateUser({ password: pw });
      if (e2) throw e2;
    }
    state.profiles.set(data.id, data);
    state.me = data;
    renderMe();
    toast('保存しました');
  });
};
