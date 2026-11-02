// Announcement board: admin posts, today's birthdays and holidays for everyone, comments on every post,
// upcoming PH/US holidays and birthdays, and the login banner (greetings and new announcements).
import {
  addDoc, collection, deleteDoc, doc, getDoc, getDocs, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import { addDays, dayKey, nextOccurrence } from './report.js?v=13';
import { $, cell, downloadBlob, el, fmt, fmtDay, show, showError } from './ui.js?v=13';

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
  // Birthdays and holidays get their own card at the top of the board; announcements stay below.
  const party = celebrations(today).map((c) => postCard(c.id, {
    className: 'celebrate', icon: c.icon, author: 'CloversVA', when: c.day === today ? 'Today' : fmtDay(c.day), title: c.title, body: c.body,
  }));
  show('celebrationsCard', party.length > 0);
  $('celebrations').replaceChildren(...party);
  const cards = posts.map((p) => {
    const remove = admin ? el('button', { className: 'link', textContent: 'Delete' }) : null;
    if (remove) remove.onclick = () => confirm(`Delete "${p.title}"?`) && deletePost(p).catch(showError);
    return postCard(p.id, { author: p.byName || 'CloversVA', when: fmt(p.at.toDate()), title: p.title, body: p.body, media: p.media, remove });
  });
  show('postsEmpty', cards.length === 0);
  $('posts').replaceChildren(...cards);
  showGreeting(today);
}

// ---------- Posts and comments ----------

// Post cards are kept between redraws so a half-typed comment survives new posts and comments.
const threads = new Map(); // thread id -> { node, head, list, count }

const avatar = (name) => el('span', { className: 'avatar', textContent: (name || '?').trim().charAt(0).toUpperCase(), ariaHidden: 'true' });

function postCard(id, { className = '', icon, author, when, title, body, media, remove }) {
  let t = threads.get(id);
  if (!t) {
    const head = el('div');
    // Built once, so a playing video keeps playing when the board redraws.
    const mediaNode = media ? mediaBlock(id, media) : null;
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
    t = { node: el('article', { className: `post ${className}` }, head, mediaNode, count, list, form), head, list, count, input };
    threads.set(id, t);
  }
  t.input.ariaLabel = `Comment on ${title}`;
  t.head.replaceChildren(
    el('div', { className: 'post-by' }, icon ? el('span', { className: 'avatar icon', textContent: icon, ariaHidden: 'true' }) : avatar(author),
      el('div', {}, el('strong', { textContent: author }), el('div', { className: 'muted small' }, when, remove ? ' · ' : null, remove))),
    el('h3', { textContent: title }),
    ...(body ? [el('p', { textContent: body })] : []),
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

// Deleting an announcement takes its comments and its attached photo, video or file with it.
async function deletePost(p) {
  const snap = await getDocs(query(collection(db, 'comments'), where('thread', '==', p.id)));
  const b = writeBatch(db);
  for (const d of snap.docs) b.delete(d.ref);
  for (let i = 0; i < (p.media?.chunks ?? 0); i += 1) b.delete(doc(db, 'announcementMedia', `${p.id}_${i}`));
  b.delete(doc(db, 'announcements', p.id));
  await b.commit();
}

// ---------- Photos, videos and files on posts ----------

// The free plan has no file storage, so a file is split into pieces small enough for one database record each
// (base64 makes each piece 4/3 bigger, staying under the 1 MB record limit).
const MEDIA_MAX_MB = 15;
const CHUNK_BYTES = 675_000;
const mediaUrls = new Map(); // post id -> Promise of a blob: URL

function loadMedia(id, media) {
  if (!mediaUrls.has(id)) {
    const parts = Array.from({ length: media.chunks }, async (_, i) => {
      const snap = await getDoc(doc(db, 'announcementMedia', `${id}_${i}`));
      if (!snap.exists()) throw new Error('Part of this file is missing. Ask an admin to post it again.');
      return (await fetch(`data:${media.mime};base64,${snap.data().data}`)).blob();
    });
    const url = Promise.all(parts).then((blobs) => URL.createObjectURL(new Blob(blobs, { type: media.mime })));
    url.catch(() => mediaUrls.delete(id));
    mediaUrls.set(id, url);
  }
  return mediaUrls.get(id);
}

// Photos load right away. Videos show their first frame and only download when someone presses play.
// Other files (PDF, Word, Excel...) show their name and a Download button.
function mediaBlock(id, media) {
  if (media.kind === 'file') {
    const get = el('button', { textContent: 'Download' });
    get.onclick = async () => {
      get.disabled = true;
      get.textContent = 'Downloading...';
      try {
        downloadBlob(media.name, await (await fetch(await loadMedia(id, media))).blob());
      } catch (err) { showError(err); } finally { get.disabled = false; get.textContent = 'Download'; }
    };
    return el('div', { className: 'post-file' }, el('span', { className: 'post-file-icon', textContent: '\u{1F4CE}', ariaHidden: 'true' }),
      el('div', {}, el('strong', { textContent: media.name }), el('div', { className: 'muted small', textContent: sizeLabel(media.size) })), get);
  }
  if (media.kind === 'image') {
    const img = el('img', { className: 'post-media', alt: '' });
    loadMedia(id, media).then((url) => { img.src = url; }).catch(showError);
    return img;
  }
  const play = el('button', { className: 'play', textContent: '\u25B6 Play video' });
  const box = el('div', { className: 'post-media post-video' },
    media.poster ? el('img', { src: media.poster, alt: '' }) : null, play);
  play.onclick = async () => {
    play.disabled = true;
    play.textContent = 'Loading...';
    try {
      const video = el('video', { className: 'post-media', controls: true, playsInline: true, src: await loadMedia(id, media) });
      box.replaceWith(video);
      video.play().catch(() => {});
    } catch (err) { play.disabled = false; play.textContent = '\u25B6 Play video'; showError(err); }
  };
  return box;
}

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

const base64Of = (blob) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result.slice(r.result.indexOf(',') + 1));
  r.onerror = () => reject(new Error('That file could not be read.'));
  r.readAsDataURL(blob);
});

// A small still from about a second in, shown before the video is played. Null if the browser can't read the video.
function videoPoster(file) {
  return new Promise((resolve) => {
    const video = el('video', { muted: true, preload: 'auto', src: URL.createObjectURL(file) });
    const done = (result) => { URL.revokeObjectURL(video.src); resolve(result); };
    setTimeout(() => done(null), 8000);
    video.onerror = () => done(null);
    video.onloadeddata = () => { video.currentTime = Math.min(1, video.duration / 2 || 0); };
    video.onseeked = () => {
      const scale = Math.min(1, 640 / video.videoWidth);
      const canvas = el('canvas', { width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) });
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
      done(canvas.toDataURL('image/jpeg', 0.7));
    };
  });
}

// Saves the pieces first, so nobody sees a post whose file is still uploading.
async function uploadMedia(postId, file) {
  const kind = file.type.startsWith('video/') ? 'video' : file.type.startsWith('image/') ? 'image' : 'file';
  const chunks = Math.ceil(file.size / CHUNK_BYTES);
  try {
    for (let i = 0; i < chunks; i += 1) {
      $('postNote').textContent = `Uploading ${Math.round((i / chunks) * 100)}%...`;
      const data = await base64Of(file.slice(i * CHUNK_BYTES, (i + 1) * CHUNK_BYTES));
      await setDoc(doc(db, 'announcementMedia', `${postId}_${i}`), { post: postId, i, data });
    }
  } catch (err) {
    for (let i = 0; i < chunks; i += 1) deleteDoc(doc(db, 'announcementMedia', `${postId}_${i}`)).catch(() => {});
    throw err;
  }
  const poster = kind === 'video' ? await videoPoster(file) : null;
  return { kind, mime: file.type || 'application/octet-stream', name: file.name.slice(0, 200), size: file.size, chunks, poster };
}

// ---------- Greeting banner and "new announcement" alert ----------

// One banner for everyone at sign-in: your own birthday, teammates' birthdays, PH/US holidays today (once a day),
// and any announcement from the last NEW_DAYS days this person hasn't opened yet (until they open the board or close it).
const NEW_DAYS = 14;
const SEEN_KEY = 'cloversva.seenAnnouncements';
let myBirthday = null;
export function setMyBirthday(monthDay) { myBirthday = monthDay; renderUpcoming(); }

function readSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}
const seen = readSeen();
function markSeen(items) {
  for (const n of items) seen.add(n.id);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-300))); } catch { /* private mode */ }
}

// Pinned cards written into the page carry data-notice (a unique id), data-date and data-title.
function unseenAnnouncements(today) {
  const since = addDays(today, -(NEW_DAYS - 1));
  const pinned = [...document.querySelectorAll('[data-notice]')].filter((n) => n.dataset.date >= since && n.dataset.date <= today)
    .map((n) => ({ id: `pinned_${n.dataset.notice}`, title: n.dataset.title }));
  const recent = posts.filter((p) => p.by !== me.email && dayKey(p.at.toDate(), PH_TZ) >= since).map((p) => ({ id: p.id, title: p.title }));
  return [...recent, ...pinned].filter((n) => !seen.has(n.id));
}

function showGreeting(today) {
  if (!me) return;
  const key = `cloversva.greeted.${today}`;
  let greeted = false;
  try { greeted = Boolean(localStorage.getItem(key)); } catch { /* private mode: show it */ }
  const lines = [];
  let greet = false;
  if (!greeted) {
    const mine = today.slice(5) === myBirthday || birthdays.some((b) => b.email === me.email && b.monthDay === today.slice(5));
    if (mine) lines.push(`Happy birthday, ${me.name}! The whole CloversVA team wishes you a wonderful day.`);
    const others = birthdays.filter((b) => b.monthDay === today.slice(5) && b.email !== me.email).map((b) => b.name);
    if (others.length) lines.push(`Today is ${joinNames(others)}'s birthday!`);
    const todays = holidays.filter((x) => x.day === today);
    for (const h of todays) lines.push(`Happy ${h.name}! Today is a ${COUNTRY[h.country]} holiday.`);
    greet = others.length > 0 || todays.length > 0;
  }
  const fresh = unseenAnnouncements(today);
  $('boardCount').textContent = String(fresh.length);
  show('boardCount', fresh.length > 0);
  if (fresh.length === 1) lines.push(`New announcement: "${fresh[0].title}".`);
  else if (fresh.length > 1) lines.push(`${fresh.length} new announcements, including "${fresh[0].title}".`);
  if (!lines.length) { show('banner', false); return; }
  if (greet) lines.push('Send your greetings on the Announcements board.');
  $('bannerText').textContent = lines.join(' ');
  $('bannerGo').textContent = fresh.length ? 'View announcements' : 'Send a greeting';
  show('banner');
  const close = () => {
    try { localStorage.setItem(key, '1'); } catch { /* fine */ }
    markSeen(fresh);
    showGreeting(today);
  };
  $('bannerClose').onclick = close;
  $('bannerGo').onclick = () => { document.querySelector('[data-view="board"]').click(); close(); };
}

// Opening the Announcements tab counts as reading what's there.
document.querySelector('[data-view="board"]').addEventListener('click', () => {
  if (!me) return;
  const today = dayKey(new Date(), PH_TZ);
  markSeen(unseenAnnouncements(today));
  showGreeting(today);
});

const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---------- Admin ----------

$('postForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('postMedia').files[0];
  if (file && file.size > MEDIA_MAX_MB * 1024 * 1024) {
    $('postNote').textContent = `That file is ${(file.size / 1048576).toFixed(1)} MB. The limit is ${MEDIA_MAX_MB} MB; trim or compress it and try again.`;
    return;
  }
  const button = e.target.querySelector('button');
  button.disabled = true;
  try {
    const ref = doc(collection(db, 'announcements'));
    const post = { title: $('postTitle').value.trim(), body: $('postBody').value.trim(), by: me.email, byName: me.name, at: serverTimestamp() };
    if (file) post.media = await uploadMedia(ref.id, file);
    await setDoc(ref, post);
    e.target.reset();
    $('postNote').textContent = 'Posted.';
  } catch (err) { $('postNote').textContent = ''; showError(err); } finally { button.disabled = false; }
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
