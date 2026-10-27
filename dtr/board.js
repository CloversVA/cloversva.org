// Announcement board: admin posts, today's birthdays and holidays for everyone, comments on every post,
// upcoming PH/US holidays and birthdays, and the login greeting banner.
import {
  addDoc, collection, deleteDoc, doc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import { addDays, dayKey, nextOccurrence } from './report.js?v=10';
import { $, cell, el, fmt, fmtDay, show, showError } from './ui.js?v=10';

const UPCOMING_DAYS = 45;
// Birthday and holiday posts stay on the board this many days, so late greetings still land.
const CELEBRATION_DAYS = 3;
const COMMENTS_SHOWN = 500;
const FLAG = { PH: 'PH', US: 'US' };
const COUNTRY = { PH: 'Philippine', US: 'US' };
// Greetings follow the Philippine calendar, where the VAs are.
const PH_TZ = 'Asia/Manila';

let me = null;
let admin = false;
let holidays = [];
let birthdays = [];
let posts = [];
const comments = new Map(); // thread id -> [comment], oldest first

export function startBoard(signedIn, track, isAdmin) {
  me = signedIn;
  admin = isAdmin;
  track(onSnapshot(collection(db, 'announcements'), (snap) => {
    posts = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort((a, b) => b.at.toMillis() - a.at.toMillis());
    renderFeed();
  }, showError));

  track(onSnapshot(collection(db, 'holidays'), (snap) => {
    holidays = snap.docs.map((d) => ({ id: d.id, ...d.data() })).sort((a, b) => a.day.localeCompare(b.day));
    renderUpcoming();
    if (isAdmin) renderHolidayAdmin();
  }, showError));

  track(onSnapshot(collection(db, 'birthdays'), (snap) => {
    birthdays = snap.docs.map((d) => ({ email: d.id, ...d.data() }));
    renderUpcoming();
  }, showError));

  track(onSnapshot(query(collection(db, 'comments'), orderBy('at', 'desc'), limit(COMMENTS_SHOWN)), (snap) => {
    comments.clear();
    for (const d of [...snap.docs].reverse()) {
      const c = { id: d.id, ...d.data({ serverTimestamps: 'estimate' }) };
      comments.set(c.thread, [...(comments.get(c.thread) ?? []), c]);
    }
    for (const id of threads.keys()) renderComments(id);
  }, (err) => {
    // Until the database rules allow comments, hide them instead of showing everyone an error.
    if (err?.code !== 'permission-denied') { showError(err); return; }
    console.warn('Comments are not allowed by the database rules yet.', err);
    document.body.classList.add('no-comments');
  }));
}

function renderUpcoming() {
  const today = dayKey(new Date(), PH_TZ);
  const until = addDays(today, UPCOMING_DAYS);
  const items = [
    ...holidays.filter((h) => h.day >= today && h.day <= until).map((h) => ({ day: h.day, text: `${h.name} (${FLAG[h.country]})`, kind: 'holiday' })),
    ...birthdays.map((b) => ({ day: nextOccurrence(b.monthDay, today), text: `${b.name}'s birthday`, kind: 'birthday' }))
      .filter((b) => b.day <= until),
  ].sort((a, b) => a.day.localeCompare(b.day));
  show('upcomingEmpty', items.length === 0);
  $('upcoming').replaceChildren(...items.map((i) => el('li', { className: i.kind },
    el('strong', { textContent: i.day === today ? 'Today' : fmtDay(i.day) }), ` ${i.text}`)));
  renderFeed();
  showGreeting(today);
}

// Birthdays and holidays from the last few days, newest first, as posts everyone sees and can comment on.
function celebrations(today) {
  const since = addDays(today, -(CELEBRATION_DAYS - 1));
  const items = [];
  for (const h of holidays.filter((x) => x.day >= since && x.day <= today)) {
    items.push({
      id: `holiday_${h.id}`, day: h.day, icon: '\u{1F389}', title: `Happy ${h.name}!`,
      body: `${h.day === today ? 'Today' : fmtDay(h.day)} is a ${COUNTRY[h.country]} holiday. Share your greetings below.`,
    });
  }
  for (let day = since; day <= today; day = addDays(day, 1)) {
    for (const b of birthdays.filter((x) => x.monthDay === day.slice(5))) {
      const mine = b.email === me.email;
      items.push({
        id: `birthday_${day.slice(0, 4)}_${b.email}`, day, icon: '\u{1F382}', title: `Happy birthday, ${mine ? 'you' : b.name}!`,
        body: mine ? 'The whole CloversVA team wishes you a wonderful day. Your teammates can leave you greetings below.'
          : `${day === today ? 'Today' : fmtDay(day)} is ${b.name}'s birthday. Leave a greeting below.`,
      });
    }
  }
  return items.sort((a, b) => b.day.localeCompare(a.day));
}

function renderFeed() {
  const today = dayKey(new Date(), PH_TZ);
  const cards = [
    ...celebrations(today).map((c) => postCard(c.id, {
      className: 'celebrate', icon: c.icon, author: 'CloversVA', when: c.day === today ? 'Today' : fmtDay(c.day), title: c.title, body: c.body,
    })),
    ...posts.map((p) => {
      const remove = admin ? el('button', { className: 'link', textContent: 'Delete' }) : null;
      if (remove) remove.onclick = () => confirm(`Delete "${p.title}"?`) && deletePost(p.id).catch(showError);
      return postCard(p.id, { author: p.byName || 'CloversVA', when: fmt(p.at.toDate()), title: p.title, body: p.body, remove });
    }),
  ];
  show('postsEmpty', cards.length === 0);
  $('posts').replaceChildren(...cards);
}

// ---------- Posts and comments ----------

// Post cards are kept between redraws so a half-typed comment survives new posts and comments.
const threads = new Map(); // thread id -> { node, head, list, count }

const avatar = (name) => el('span', { className: 'avatar', textContent: (name || '?').trim().charAt(0).toUpperCase(), ariaHidden: 'true' });

function postCard(id, { className = '', icon, author, when, title, body, remove }) {
  let t = threads.get(id);
  if (!t) {
    const head = el('div');
    const count = el('p', { className: 'muted comment-count' });
    const list = el('ul', { className: 'comments' });
    const input = el('input', { maxLength: 500, required: true, placeholder: 'Write a comment...', autocomplete: 'off' });
    const send = el('button', { className: 'primary', textContent: 'Send' });
    const form = el('form', { className: 'comment-form' }, avatar(me.name), input, send);
    form.onsubmit = async (e) => {
      e.preventDefault();
      const text = input.value.trim();
      if (!text) return;
      send.disabled = true;
      try {
        await addDoc(collection(db, 'comments'), { thread: id, email: me.email, name: me.name, text, at: serverTimestamp() });
        input.value = '';
      } catch (err) { showError(err); } finally { send.disabled = false; }
    };
    t = { node: el('article', { className: `post ${className}` }, head, count, list, form), head, list, count, input };
    threads.set(id, t);
  }
  t.input.ariaLabel = `Comment on ${title}`;
  t.head.replaceChildren(
    el('div', { className: 'post-by' }, icon ? el('span', { className: 'avatar icon', textContent: icon, ariaHidden: 'true' }) : avatar(author),
      el('div', {}, el('strong', { textContent: author }), el('div', { className: 'muted small' }, when, remove ? ' · ' : null, remove))),
    el('h3', { textContent: title }),
    body ? el('p', { textContent: body }) : null,
  );
  renderComments(id);
  return t.node;
}

function renderComments(id) {
  const t = threads.get(id);
  const list = comments.get(id) ?? [];
  t.count.textContent = list.length ? `${list.length} comment${list.length === 1 ? '' : 's'}` : '';
  t.list.replaceChildren(...list.map((c) => {
    let remove = null;
    if (admin || c.email === me.email) {
      remove = el('button', { className: 'link', textContent: 'Delete' });
      remove.onclick = () => confirm('Delete this comment?') && deleteDoc(doc(db, 'comments', c.id)).catch(showError);
    }
    return el('li', { className: 'comment' }, avatar(c.name),
      el('div', {}, el('div', { className: 'bubble' }, el('strong', { textContent: c.name }), el('p', { textContent: c.text })),
        el('div', { className: 'muted small' }, fmt(c.at.toDate()), remove ? ' · ' : null, remove)));
  }));
}

// Deleting an announcement takes its comments with it.
async function deletePost(id) {
  const snap = await getDocs(query(collection(db, 'comments'), where('thread', '==', id)));
  const b = writeBatch(db);
  for (const d of snap.docs) b.delete(d.ref);
  b.delete(doc(db, 'announcements', id));
  await b.commit();
}

// ---------- Greeting banner ----------

// One banner per day for everyone: your own birthday, teammates' birthdays, and PH/US holidays today.
let myBirthday = null;
export function setMyBirthday(monthDay) { myBirthday = monthDay; renderUpcoming(); }

function showGreeting(today) {
  if (!me) return;
  const key = `cloversva.greeted.${today}`;
  try { if (localStorage.getItem(key)) return; } catch { /* private mode: show it */ }
  const lines = [];
  const mine = today.slice(5) === myBirthday || birthdays.some((b) => b.email === me.email && b.monthDay === today.slice(5));
  if (mine) lines.push(`Happy birthday, ${me.name}! The whole CloversVA team wishes you a wonderful day.`);
  const others = birthdays.filter((b) => b.monthDay === today.slice(5) && b.email !== me.email).map((b) => b.name);
  if (others.length) lines.push(`Today is ${joinNames(others)}'s birthday!`);
  const todays = holidays.filter((x) => x.day === today);
  for (const h of todays) lines.push(`Happy ${h.name}! Today is a ${COUNTRY[h.country]} holiday.`);
  if (!lines.length) { show('banner', false); return; }
  if (others.length || todays.length) lines.push('Send your greetings on the Announcements board.');
  $('bannerText').textContent = lines.join(' ');
  show('banner');
  const close = () => {
    show('banner', false);
    try { localStorage.setItem(key, '1'); } catch { /* fine */ }
  };
  $('bannerClose').onclick = close;
  $('bannerGo').onclick = () => { document.querySelector('[data-view="board"]').click(); close(); };
}

const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---------- Admin ----------

$('postForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'announcements'), {
      title: $('postTitle').value.trim(), body: $('postBody').value.trim(), by: me.email, byName: me.name, at: serverTimestamp(),
    });
    e.target.reset();
  } catch (err) { showError(err); }
};

function renderHolidayAdmin() {
  const from = addDays(dayKey(new Date(), PH_TZ), -30);
  $('holidayRows').replaceChildren(...holidays.filter((h) => h.day >= from).map((h) => {
    const remove = el('button', { className: 'danger', textContent: 'Delete' });
    remove.onclick = () => confirm(`Delete ${h.name}?`) && deleteDoc(doc(db, 'holidays', h.id)).catch(showError);
    return el('tr', {}, cell(fmtDay(h.day)), cell(h.country), cell(h.name), cell(remove));
  }));
}

$('holidayForm').onsubmit = async (e) => {
  e.preventDefault();
  const day = $('holDay').value; const country = $('holCountry').value;
  try {
    await setDoc(doc(db, 'holidays', `${day}_${country}`), { day, country, name: $('holName').value.trim() });
    e.target.reset();
  } catch (err) { showError(err); }
};
