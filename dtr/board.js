// Announcement board: admin posts, upcoming PH/US holidays and birthdays, and the login greeting banner.
import {
  addDoc, collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import { addDays, dayKey, nextOccurrence } from './report.js?v=9';
import { $, cell, el, fmt, fmtDay, show, showError } from './ui.js?v=9';

const UPCOMING_DAYS = 45;
const FLAG = { PH: 'PH', US: 'US' };
// Greetings follow the Philippine calendar, where the VAs are.
const PH_TZ = 'Asia/Manila';

let me = null;
let holidays = [];
let birthdays = [];

export function startBoard(signedIn, track, isAdmin) {
  me = signedIn;
  track(onSnapshot(collection(db, 'announcements'), (snap) => {
    const posts = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort((a, b) => b.at.toMillis() - a.at.toMillis());
    show('postsEmpty', posts.length === 0);
    $('posts').replaceChildren(...posts.map((p) => {
      const remove = isAdmin ? el('button', { className: 'link', textContent: 'Delete' }) : null;
      if (remove) remove.onclick = () => confirm(`Delete "${p.title}"?`) && deleteDoc(doc(db, 'announcements', p.id)).catch(showError);
      return el('article', { className: 'post' }, el('h3', { textContent: p.title }),
        p.body ? el('p', { textContent: p.body }) : null, el('p', { className: 'muted', textContent: fmt(p.at.toDate()) }, remove ? ' · ' : null, remove));
    }));
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
  showGreeting(today);
}

// One greeting per day: the VA's birthday, or a Philippine holiday today.
let myBirthday = null;
export function setMyBirthday(monthDay) { myBirthday = monthDay; renderUpcoming(); }

function showGreeting(today) {
  const key = `cloversva.greeted.${today}`;
  try { if (localStorage.getItem(key)) return; } catch { /* private mode: show it */ }
  const lines = [];
  if (myBirthday && today.slice(5) === myBirthday) lines.push(`Happy birthday, ${me.name}! The whole CloversVA team wishes you a wonderful day.`);
  for (const h of holidays.filter((x) => x.day === today && x.country === 'PH')) lines.push(`Happy ${h.name}! Today is a Philippine holiday.`);
  if (!lines.length) return;
  $('bannerText').textContent = lines.join(' ');
  show('banner');
  $('bannerClose').onclick = () => {
    show('banner', false);
    try { localStorage.setItem(key, '1'); } catch { /* fine */ }
  };
}

// ---------- Admin ----------

$('postForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await addDoc(collection(db, 'announcements'), { title: $('postTitle').value.trim(), body: $('postBody').value.trim(), by: me.email, at: serverTimestamp() });
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
