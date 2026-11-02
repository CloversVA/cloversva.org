// Private inbox: each VA has one conversation with the CloversVA admins. Only that VA and the admins can read it
// (enforced by the database rules). The number on the Inbox menu item counts messages you haven't opened yet.
import {
  addDoc, collection, doc, limit, onSnapshot, orderBy, query, serverTimestamp, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import { emojiPicker } from './board.js?v=17';
import { $, el, fmt, show, showError } from './ui.js?v=13';

const ADMIN_MESSAGES_SHOWN = 2000;

let me = null;
let admin = false;
let messages = []; // every message this person can see, oldest first
let people = new Map(); // admins only: email -> { email, name } for every active VA
let openVa = null; // the VA whose conversation is open (for a VA, always themselves)
let loaded = false; // admins: open the most recent conversation once the messages have arrived

const avatar = (name) => el('span', { className: 'avatar', textContent: (name || '?').trim().charAt(0).toUpperCase(), ariaHidden: 'true' });
// A message is unread for me if the other side sent it and nobody on my side has opened it.
const unreadForMe = (m) => !m.read && m.fromAdmin !== admin;
const inboxOpen = () => !$('inboxPanel').hidden && document.visibilityState === 'visible';

export function startInbox(signedIn, track, isAdmin) {
  me = signedIn;
  admin = isAdmin;
  openVa = admin ? null : me.email;
  $('inboxIntro').textContent = admin
    ? 'Private conversations with each VA. Only the admins and that VA can see a conversation.'
    : 'Private messages between you and the CloversVA admins. Other VAs can\'t see them.';
  show('inboxPeople', admin);
  const input = $('inboxInput');
  $('inboxForm').insertBefore(emojiPicker(input), $('inboxSend'));

  const source = admin
    ? query(collection(db, 'inbox'), orderBy('at', 'desc'), limit(ADMIN_MESSAGES_SHOWN))
    : query(collection(db, 'inbox'), where('va', '==', me.email));
  track(onSnapshot(source, (snap) => {
    messages = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .sort((a, b) => a.at.toMillis() - b.at.toMillis());
    loaded = true;
    render();
  }, (err) => {
    if (err?.code !== 'permission-denied') { showError(err); return; }
    // The database rules for the inbox haven't been added yet.
    console.warn('The inbox is not allowed by the database rules yet.', err);
    show('inboxOff');
    show('inboxForm', false);
  }));

  document.querySelector('[data-view="inbox"]').addEventListener('click', () => setTimeout(render));
  document.addEventListener('visibilitychange', () => { if (inboxOpen()) render(); });
}

// Admins: called by the admin screen whenever the VA list changes.
export function setInboxPeople(vas) {
  people = new Map(vas.filter((v) => v.active && v.email !== me?.email).map((v) => [v.email, { email: v.email, name: v.name || v.email }]));
  render();
}

function render() {
  if (!me) return;
  const unread = messages.filter(unreadForMe);
  $('inboxCount').textContent = String(unread.length);
  show('inboxCount', unread.length > 0);
  if (admin) renderPeople();
  renderThread();
}

function renderPeople() {
  const byVa = new Map();
  for (const m of messages) byVa.set(m.va, [...(byVa.get(m.va) ?? []), m]);
  // Anyone who has written in, plus every active VA, with the most recent conversation first.
  const list = new Map(people);
  for (const [va, msgs] of byVa) if (!list.has(va)) list.set(va, { email: va, name: msgs.at(-1).vaName || va });
  const rows = [...list.values()].map((p) => {
    const msgs = byVa.get(p.email) ?? [];
    return { ...p, last: msgs.at(-1), unread: msgs.filter(unreadForMe).length };
  }).sort((a, b) => (b.last?.at.toMillis() ?? 0) - (a.last?.at.toMillis() ?? 0) || a.name.localeCompare(b.name));
  if (!openVa && loaded && rows.length) openVa = rows[0].email;

  $('inboxPeople').replaceChildren(...rows.map((p) => {
    const b = el('button', { type: 'button', className: 'inbox-person' },
      avatar(p.name),
      el('span', { className: 'inbox-person-text' }, el('strong', { textContent: p.name }),
        el('span', { className: 'muted small', textContent: p.last ? p.last.text : 'No messages yet' })),
      p.unread ? el('span', { className: 'badge', textContent: String(p.unread) }) : null);
    if (p.email === openVa) b.setAttribute('aria-current', 'true');
    b.onclick = () => { openVa = p.email; render(); $('inboxInput').focus(); };
    return el('li', {}, b);
  }));
  show('inboxNoPeople', rows.length === 0);
}

function renderThread() {
  const name = admin ? (people.get(openVa)?.name ?? messages.findLast((m) => m.va === openVa)?.vaName ?? '') : 'CloversVA admins';
  show('inboxThread', Boolean(openVa));
  if (!openVa) return;
  $('inboxWith').textContent = name;
  $('inboxInput').ariaLabel = `Message to ${name}`;
  const thread = messages.filter((m) => m.va === openVa);
  show('inboxEmpty', thread.length === 0);
  const box = $('inboxMessages');
  const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 40;
  box.replaceChildren(...thread.map((m) => {
    const mine = m.fromAdmin === admin;
    const who = mine && m.from === me.email ? 'You' : m.fromAdmin ? `${m.fromName} (CloversVA)` : m.fromName;
    return el('li', { className: `chat-msg ${mine ? 'mine' : 'theirs'}` },
      el('div', { className: 'chat-bubble', textContent: m.text }),
      el('div', { className: 'muted small', textContent: `${who} · ${fmt(m.at.toDate())}` }));
  }));
  if (atBottom || box.dataset.va !== openVa) box.scrollTop = box.scrollHeight;
  box.dataset.va = openVa;
  if (inboxOpen()) markRead(thread.filter(unreadForMe));
}

let marking = false;
async function markRead(list) {
  if (!list.length || marking) return;
  marking = true;
  try {
    const b = writeBatch(db);
    for (const m of list) b.update(doc(db, 'inbox', m.id), { read: true });
    await b.commit();
  } catch (err) { showError(err); } finally { marking = false; }
}

$('inboxForm').onsubmit = async (e) => {
  e.preventDefault();
  const input = $('inboxInput');
  const text = input.value.trim();
  if (!text || !openVa) return;
  $('inboxSend').disabled = true;
  try {
    await addDoc(collection(db, 'inbox'), {
      va: openVa, vaName: admin ? (people.get(openVa)?.name ?? '') : me.name,
      from: me.email, fromName: me.name, fromAdmin: admin, text, read: false, at: serverTimestamp(),
    });
    input.value = '';
  } catch (err) { showError(err); } finally { $('inboxSend').disabled = false; }
};
