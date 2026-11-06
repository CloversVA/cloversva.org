// Announcement board: admin posts with emoji reactions, today's birthdays and holidays for everyone, comments on every post,
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
const COMMENTS_SHOWN = 1500; // messages and emoji reactions together
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
  addPinnedThreads();
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
    // Tell admins why the reaction and comment boxes are missing, so it can be fixed in the database rules.
    if (admin) show('commentsOff');
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
const threads = new Map(); // thread id -> { node, head, list, count, input }

const avatar = (name) => el('span', { className: 'avatar', textContent: (name || '?').trim().charAt(0).toUpperCase(), ariaHidden: 'true' });

const EMOJIS = ['🍀', '😀', '😊', '😂', '🥰', '😍', '🤗', '😎', '🥳', '😢', '🙏', '👏', '👍', '👋', '💪', '🙌', '❤️', '💚', '🎉', '🎂', '🎁', '🌟', '🔥', '✨', '💐', '☕', '✅', '💯'];

// An emoji button that opens a small grid; picking one types it into the message where the cursor is.
function emojiPicker(input) {
  const grid = el('div', { className: 'emoji-grid', role: 'menu', hidden: true });
  const toggle = el('button', { type: 'button', className: 'emoji-toggle', textContent: '😊', title: 'Add an emoji', ariaLabel: 'Add an emoji' });
  const close = () => { grid.hidden = true; document.removeEventListener('click', outside); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  for (const emoji of EMOJIS) {
    const b = el('button', { type: 'button', textContent: emoji, ariaLabel: emoji, role: 'menuitem' });
    b.onclick = () => {
      const at = input.selectionStart ?? input.value.length;
      const end = input.selectionEnd ?? at;
      if (input.value.length - (end - at) + emoji.length > input.maxLength) return;
      input.setRangeText(emoji, at, end, 'end');
      input.focus();
    };
    grid.append(b);
  }
  toggle.onclick = () => {
    if (!grid.hidden) { close(); return; }
    grid.hidden = false;
    setTimeout(() => document.addEventListener('click', outside));
  };
  const box = el('div', { className: 'emoji-box' }, toggle, grid);
  return box;
}

// ---------- Emoji reactions ----------

// Everyone can react to any post with one emoji (pick another to change it, tap yours again to remove it).
// Reactions are saved as comments on a separate "react_<post id>" thread, so they need no extra database rules.
const REACTIONS = ['🍀', '👍', '❤️', '😂', '😮', '😢', '🎉', '👏', '🙏', '💚'];
const reactThread = (id) => `react_${id}`;

// One compact summary per post ("❤️🎉👏 12"); tapping it lists each emoji with its count and who reacted.
function reactionBar(id) {
  const summary = el('button', { type: 'button', className: 'reaction-summary', hidden: true });
  const details = el('ul', { className: 'reaction-details', hidden: true });
  summary.onclick = () => {
    details.hidden = !details.hidden;
    summary.ariaExpanded = String(!details.hidden);
  };
  const grid = el('div', { className: 'reaction-grid', role: 'menu', hidden: true });
  const add = el('button', { type: 'button', className: 'reaction-add', textContent: '🙂 React' });
  const box = el('div', { className: 'reaction-pick' }, add, grid);
  const close = () => { grid.hidden = true; document.removeEventListener('click', outside); };
  const outside = (e) => { if (!box.contains(e.target)) close(); };
  for (const emoji of REACTIONS) {
    const b = el('button', { type: 'button', textContent: emoji, ariaLabel: `React with ${emoji}`, role: 'menuitem' });
    b.onclick = () => { close(); react(id, emoji); };
    grid.append(b);
  }
  add.onclick = () => {
    if (!grid.hidden) { close(); return; }
    grid.hidden = false;
    setTimeout(() => document.addEventListener('click', outside));
  };
  return { reactions: el('div', { className: 'reactions-wrap' }, el('div', { className: 'reactions' }, box, summary), details), summary, details, add, grid };
}

const busy = new Set(); // posts with a reaction being saved, so double taps don't add two
async function react(id, emoji) {
  if (busy.has(id)) return;
  busy.add(id);
  try {
    const mine = (comments.get(reactThread(id)) ?? []).filter((c) => c.email === me.email);
    await Promise.all(mine.map((c) => deleteDoc(doc(db, 'comments', c.id))));
    // Tapping the emoji you already picked just takes your reaction off.
    if (!mine.some((c) => c.text === emoji)) {
      await addDoc(collection(db, 'comments'), { thread: reactThread(id), email: me.email, name: me.name, text: emoji, at: serverTimestamp() });
    }
  } catch (err) { showError(err); } finally { busy.delete(id); }
}

function renderReactions(id) {
  const t = threads.get(id);
  const all = comments.get(reactThread(id)) ?? [];
  const byEmoji = new Map();
  for (const c of all) byEmoji.set(c.text, [...(byEmoji.get(c.text) ?? []), c]);
  const ranked = [...byEmoji].sort((a, b) => b[1].length - a[1].length);
  const mine = all.find((c) => c.email === me.email);

  // Your own reaction shows on the button; pick it again to take it off.
  t.add.textContent = mine ? `${mine.text} Reacted` : '🙂 React';
  t.add.classList.toggle('mine', Boolean(mine));
  t.add.ariaLabel = mine ? `You reacted ${mine.text}. Change or remove your reaction` : 'Add a reaction';
  for (const b of t.grid.children) b.classList.toggle('mine', b.textContent === mine?.text);

  t.summary.hidden = all.length === 0;
  if (!all.length) t.details.hidden = true;
  const total = all.length === 1 ? '1 reaction' : `${all.length} reactions`;
  t.summary.replaceChildren(el('span', { className: 'reaction-icons', textContent: ranked.slice(0, 3).map(([e]) => e).join(''), ariaHidden: 'true' }),
    el('span', { textContent: String(all.length), ariaHidden: 'true' }));
  t.summary.ariaLabel = `${total}. Show who reacted`;
  t.summary.title = total;
  t.details.replaceChildren(...ranked.map(([emoji, list]) => el('li', {},
    el('span', { className: 'reaction-row-emoji', textContent: `${emoji} ${list.length}` }),
    el('span', { className: 'muted', textContent: joinNames(list.map((c) => (c.email === me.email ? 'You' : c.name))) }))));
}

// The message list and "Write a message" box under a post, saved as comments on that post's thread.
function threadParts(id) {
  const count = el('p', { className: 'muted comment-count' });
  const list = el('ul', { className: 'comments' });
  const input = el('input', { maxLength: 500, required: true, placeholder: 'Write a message...', autocomplete: 'off' });
  const send = el('button', { className: 'primary', textContent: 'Send' });
  const form = el('form', { className: 'comment-form' }, avatar(me.name), input, emojiPicker(input), send);
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
  return { ...reactionBar(id), count, list, form, input };
}

function postCard(id, { className = '', icon, author, when, title, body, media, remove }) {
  let t = threads.get(id);
  if (!t) {
    const head = el('div');
    // Built once, so a playing video keeps playing when the board redraws.
    const mediaNode = media ? mediaBlock(id, media) : null;
    const parts = threadParts(id);
    t = { node: el('article', { className: `post ${className}` }, head, mediaNode, parts.reactions, parts.count, parts.list, parts.form), head, ...parts };
    threads.set(id, t);
  }
  t.input.ariaLabel = `Message on ${title}`;
  t.head.replaceChildren(
    el('div', { className: 'post-by' }, icon ? el('span', { className: 'avatar icon', textContent: icon, ariaHidden: 'true' }) : avatar(author),
      el('div', {}, el('strong', { textContent: author }), el('div', { className: 'muted small' }, when, remove ? ' · ' : null, remove))),
    el('h3', { textContent: title }),
    ...(body ? [el('p', { textContent: body })] : []),
  );
  renderComments(id);
  return t.node;
}

// Pinned cards written into the page (data-notice) get the same message box as posts.
function addPinnedThreads() {
  for (const card of document.querySelectorAll('[data-notice]')) {
    const id = `pinned_${card.dataset.notice}`;
    if (threads.has(id)) continue;
    const parts = threadParts(id);
    parts.input.ariaLabel = `Message on ${card.dataset.title}`;
    card.append(parts.reactions, parts.count, parts.list, parts.form);
    threads.set(id, { node: card, ...parts });
    renderComments(id);
  }
}

function renderComments(id) {
  const t = threads.get(id);
  renderReactions(id);
  const list = comments.get(id) ?? [];
  t.count.textContent = list.length ? `${list.length} message${list.length === 1 ? '' : 's'}` : '';
  t.list.replaceChildren(...list.map((c) => {
    let remove = null;
    if (admin || c.email === me.email) {
      remove = el('button', { className: 'link', textContent: 'Delete' });
      remove.onclick = () => confirm('Delete this message?') && deleteDoc(doc(db, 'comments', c.id)).catch(showError);
    }
    return el('li', { className: 'comment' }, avatar(c.name),
      el('div', {}, el('div', { className: 'bubble' }, el('strong', { textContent: c.name }), el('p', { textContent: c.text })),
        el('div', { className: 'muted small' }, fmt(c.at.toDate()), remove ? ' · ' : null, remove)));
  }));
}

// Deleting an announcement takes its comments, reactions and attached photo, video or file with it.
async function deletePost(p) {
  const snap = await getDocs(query(collection(db, 'comments'), where('thread', 'in', [p.id, reactThread(p.id)])));
  const b = writeBatch(db);
  for (const d of snap.docs) b.delete(d.ref);
  for (let i = 0; i < (p.media?.chunks ?? 0); i += 1) b.delete(doc(db, 'announcementMedia', `${p.id}_${i}`));
  b.delete(doc(db, 'announcements', p.id));
  await b.commit();
}

// ---------- Photos, videos and files on posts ----------

// Older posts: the file was split into pieces saved in the database ("announcementMedia"), since the free plan has
// no file storage. Good-vibes posts instead point at a short clip kept on the website (media.src, a file in /images),
// shown like a GIF.
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
  const tall = media.tall ? ' tall' : '';
  const siteFile = /^[\w-]+\.mp4$/.test(media.src ?? '') ? `../images/${media.src}` : null;
  // Good-vibes clips play like a GIF: on their own, silent, looping, with no buttons.
  if (siteFile) {
    const gif = el('video', { className: `post-media post-gif${tall}`, src: siteFile, poster: media.poster || '',
      autoplay: true, muted: true, loop: true, playsInline: true, preload: 'auto', disablePictureInPicture: true });
    for (const a of ['autoplay', 'muted', 'loop', 'playsinline']) gif.setAttribute(a, ''); // iPhones need the attributes too
    gif.setAttribute('aria-label', media.name ? `Animation: ${media.name.replace(/\.mp4$/, '').replace(/-/g, ' ')}` : 'Animation');
    return gif;
  }
  const play = el('button', { className: 'play', textContent: '\u25B6 Play video' });
  const box = el('div', { className: `post-media post-video${tall}` },
    media.poster ? el('img', { src: media.poster, alt: '' }) : null, play);
  play.onclick = async () => {
    play.disabled = true;
    play.textContent = 'Loading...';
    try {
      const video = el('video', { className: `post-media${tall}`, controls: true, playsInline: true, src: await loadMedia(id, media) });
      box.replaceWith(video);
      video.play().catch(() => {});
    } catch (err) { play.disabled = false; play.textContent = '\u25B6 Play video'; showError(err); }
  };
  return box;
}

const sizeLabel = (bytes) => (bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`);

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
  if (greet) lines.push('Send your greetings on the Announcement Wall.');
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

// Opening the Announcement Wall tab counts as reading what's there.
document.querySelector('[data-view="board"]').addEventListener('click', () => {
  if (!me) return;
  const today = dayKey(new Date(), PH_TZ);
  markSeen(unseenAnnouncements(today));
  showGreeting(today);
});

const joinNames = (names) => (names.length < 2 ? names.join('') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)}`);

// ---------- Admin ----------

// One-click "good vibes" posts: a short message and an animation (a looping clip) that lives on the website, so nothing is uploaded.
const VIBES = {
  soon: {
    title: 'Payday is on the way, Team Trust! \u{1F340}',
    body: 'Hang in there, team! Your hard work is about to pay off. Just a few more days: keep shining, stay lucky, and finish the week strong. \u{1F49A}',
    video: 'payday-on-the-way.mp4', poster: 'payday-on-the-way.jpg',
  },
  paid: {
    title: 'May sahod na, Team Trust! \u{1F389}',
    body: 'Salamat sa sipag at tiyaga, team! Your pay for this cut-off has been sent. Enjoy your well-deserved sahod! \u{1F340}',
    video: 'payday-paid.mp4', poster: 'payday-paid.jpg',
  },
};

for (const button of document.querySelectorAll('[data-vibe]')) {
  button.onclick = async () => {
    const v = VIBES[button.dataset.vibe];
    if (!confirm(`Post "${v.title}" with its animation to the Announcement Wall for everyone?`)) return;
    button.disabled = true;
    try {
      await setDoc(doc(collection(db, 'announcements')), {
        title: v.title, body: v.body, by: me.email, byName: me.name, at: serverTimestamp(),
        media: { kind: 'video', mime: 'video/mp4', name: v.video, size: 0, chunks: 0, src: v.video, poster: `../images/${v.poster}`, tall: true },
      });
      $('postNote').textContent = 'Posted.';
    } catch (err) { $('postNote').textContent = ''; showError(err); } finally { button.disabled = false; }
  };
}

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
