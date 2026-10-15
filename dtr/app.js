import { initializeApp } from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js';
import {
  GoogleAuthProvider, connectAuthEmulator, getAuth, onAuthStateChanged, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {
  Timestamp, collection, connectFirestoreEmulator, doc, getDoc, getDocs, getFirestore, limit, onSnapshot,
  orderBy, query, serverTimestamp, setDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { firebaseConfig } from './firebase-config.js';
import { formatDuration, periodRange, summarize, toCsv, totalsToCsv } from './report.js';

const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
const MY_SHIFTS_SHOWN = 14;

const fbApp = initializeApp(LOCAL
  ? { apiKey: 'demo-key', projectId: 'demo-vatime', authDomain: location.host }
  : firebaseConfig);
const auth = getAuth(fbApp);
const db = getFirestore(fbApp);
if (LOCAL) {
  connectAuthEmulator(auth, 'http://127.0.0.1:9099', { disableWarnings: true });
  connectFirestoreEmulator(db, '127.0.0.1', 8080);
}

const $ = (id) => document.getElementById(id);
const show = (id, on = true) => { $(id).hidden = !on; };
const fmt = (d) => d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const asDate = (ts) => (ts ? ts.toDate() : null);

// Builds elements with textContent only, so names typed by admins can never inject HTML.
function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null));
  return node;
}
const cell = (...kids) => el('td', {}, ...kids);

function showError(err) {
  console.error(err);
  $('error').textContent = err?.code === 'permission-denied'
    ? 'That action is not allowed. Reload the page and try again.'
    : `Something went wrong: ${err?.message ?? err}`;
  show('error');
}

let me = null; // { email, name, role }
let unsubs = [];
function stopListening() { unsubs.forEach((u) => u()); unsubs = []; }

// One ticker keeps every running timer on the page current.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) {
    node.textContent = formatDuration(Date.now() - Number(node.dataset.since));
  }
}, 1000);

$('signInBtn').onclick = () => {
  const provider = new GoogleAuthProvider();
  signInWithPopup(auth, provider).catch((err) => {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    if (err.code === 'auth/popup-blocked') {
      showError({ message: 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.' });
    } else showError(err);
  });
};
$('signOut').onclick = () => signOut(auth);

onAuthStateChanged(auth, async (user) => {
  stopListening();
  for (const id of ['signin', 'pending', 'clock', 'mine', 'admin', 'who', 'error']) show(id, false);
  show('loading', false);
  if (!user) { show('signin'); return; }

  const email = user.email.toLowerCase();
  show('who'); $('whoName').textContent = email;
  try {
    const snap = await getDoc(doc(db, 'allowed', email));
    if (!snap.exists() || !snap.data().active) {
      $('pendingEmail').textContent = email;
      show('pending');
      return;
    }
    me = { email, ...snap.data() };
    $('whoName').textContent = me.name;
    startClock();
    if (me.role === 'admin') startAdmin();
  } catch (err) { showError(err); }
});

// ---------- VA: clock in / out ----------

let openShift = null; // { entryId, since: Date } while on the clock

function startClock() {
  show('clock'); show('mine');
  unsubs.push(onSnapshot(doc(db, 'status', me.email), (snap) => {
    const data = snap.data({ serverTimestamps: 'estimate' });
    openShift = data ? { entryId: data.entryId, since: data.clockIn.toDate() } : null;
    $('clockState').textContent = openShift ? `On the clock since ${fmt(openShift.since)}` : 'You are clocked out.';
    $('clockBtn').textContent = openShift ? 'Clock out' : 'Clock in';
    const timer = $('clockTimer');
    if (openShift) timer.dataset.since = openShift.since.getTime(); else delete timer.dataset.since;
    timer.textContent = openShift ? formatDuration(Date.now() - openShift.since) : '';
  }, showError));

  const mine = query(collection(db, 'entries'), where('email', '==', me.email), orderBy('clockIn', 'desc'), limit(MY_SHIFTS_SHOWN));
  unsubs.push(onSnapshot(mine, (snap) => {
    $('mineRows').replaceChildren(...snap.docs.map((d) => {
      const s = d.data({ serverTimestamps: 'estimate' });
      const start = asDate(s.clockIn); const end = asDate(s.clockOut);
      return el('tr', {}, cell(fmt(start)), cell(end ? fmt(end) : 'Open'), cell(end ? formatDuration(end - start) : ''));
    }));
  }, showError));
}

$('clockBtn').onclick = async () => {
  const btn = $('clockBtn');
  btn.disabled = true;
  try {
    const b = writeBatch(db);
    const statusRef = doc(db, 'status', me.email);
    if (openShift) {
      b.update(doc(db, 'entries', openShift.entryId), { clockOut: serverTimestamp() });
      b.delete(statusRef);
    } else {
      const entryRef = doc(collection(db, 'entries'));
      b.set(entryRef, { email: me.email, name: me.name, clockIn: serverTimestamp(), clockOut: null });
      b.set(statusRef, { entryId: entryRef.id, clockIn: serverTimestamp(), name: me.name });
    }
    await b.commit();
  } catch (err) { showError(err); } finally { btn.disabled = false; }
};

// ---------- Admin ----------

function startAdmin() {
  show('admin');
  unsubs.push(onSnapshot(collection(db, 'status'), (snap) => {
    $('nowRows').replaceChildren(...snap.docs.map((d) => {
      const since = d.data({ serverTimestamps: 'estimate' }).clockIn.toDate();
      const timer = el('span', { textContent: formatDuration(Date.now() - since) });
      timer.dataset.since = since.getTime();
      return el('tr', {}, cell(d.data().name), cell(fmt(since)), cell(timer));
    }));
    show('nowEmpty', snap.empty);
  }, showError));

  unsubs.push(onSnapshot(collection(db, 'allowed'), (snap) => {
    const rows = snap.docs.map((d) => ({ email: d.id, ...d.data() })).sort((a, b) => a.name.localeCompare(b.name));
    $('vaRows').replaceChildren(...rows.map((va) => {
      const toggle = el('button', { textContent: va.active ? 'Deactivate' : 'Reactivate', disabled: va.email === me.email });
      toggle.onclick = () => setDoc(doc(db, 'allowed', va.email), { name: va.name, role: va.role, active: !va.active }).catch(showError);
      return el('tr', {}, cell(va.name), cell(va.email), cell(va.role === 'admin' ? 'Admin' : 'VA'),
        cell(va.active ? 'Active' : 'Deactivated'), cell(toggle));
    }));
  }, showError));

  setPeriod('thisWeek');
}

function setPeriod(kind) {
  const [from, to] = periodRange(kind);
  $('from').value = toDateInput(from);
  $('to').value = toDateInput(to);
}

for (const btn of document.querySelectorAll('[data-period]')) {
  btn.onclick = () => { setPeriod(btn.dataset.period); runReport().catch(showError); };
}

for (const tab of document.querySelectorAll('[data-tab]')) {
  tab.onclick = () => {
    for (const t of document.querySelectorAll('[data-tab]')) t.setAttribute('aria-selected', String(t === tab));
    for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== tab.dataset.tab;
  };
}

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('newEmail').value.trim().toLowerCase();
  try {
    await setDoc(doc(db, 'allowed', email), { name: $('newName').value.trim(), role: $('newRole').value, active: true });
    e.target.reset();
  } catch (err) { showError(err); }
};

// ---------- Admin: report ----------

const pad = (n) => String(n).padStart(2, '0');
const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const toDateTimeInput = (d) => `${toDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

let reportShifts = [];

async function runReport() {
  const from = new Date(`${$('from').value}T00:00`);
  const to = new Date(`${$('to').value}T00:00`); to.setDate(to.getDate() + 1);
  const q = query(collection(db, 'entries'),
    where('clockIn', '>=', Timestamp.fromDate(from)), where('clockIn', '<', Timestamp.fromDate(to)), orderBy('clockIn'));
  const snap = await getDocs(q);
  reportShifts = snap.docs.map((d) => {
    const s = d.data();
    return { id: d.id, email: s.email, name: s.name, clockIn: asDate(s.clockIn), clockOut: asDate(s.clockOut), edited: !!s.lastEditId };
  });

  $('totalRows').replaceChildren(...summarize(reportShifts).map((r) =>
    el('tr', {}, cell(r.name), cell(String(r.shifts)), cell(r.hours.toFixed(2)), cell(r.open ? String(r.open) : ''))));
  $('shiftRows').replaceChildren(...reportShifts.map((s) => {
    const edit = el('button', { textContent: s.clockOut ? 'Fix' : 'Close shift' });
    edit.onclick = () => openEditor(s);
    return el('tr', {}, cell(s.name), cell(fmt(s.clockIn)),
      cell(s.clockOut ? fmt(s.clockOut) : 'Open'), cell(s.clockOut ? formatDuration(s.clockOut - s.clockIn) : ''),
      cell(edit, s.edited ? el('span', { className: 'muted', textContent: ' edited' }) : null));
  }));
  $('csvBtn').disabled = reportShifts.length === 0;
}

$('reportForm').onsubmit = (e) => { e.preventDefault(); runReport().catch(showError); };

$('csvBtn').onclick = () => {
  const csv = `${totalsToCsv(summarize(reportShifts))}\r\n\r\n${toCsv(reportShifts, (d) => toDateTimeInput(d).replace('T', ' '))}`;
  const a = el('a', {
    href: URL.createObjectURL(new Blob([csv], { type: 'text/csv' })),
    download: `va-hours_${$('from').value}_to_${$('to').value}.csv`,
  });
  a.click();
  URL.revokeObjectURL(a.href);
};

// ---------- Admin: fix a shift ----------

let editing = null;

async function openEditor(shift) {
  editing = shift;
  $('editName').textContent = shift.name;
  $('editIn').value = toDateTimeInput(shift.clockIn);
  $('editOut').value = shift.clockOut ? toDateTimeInput(shift.clockOut) : '';
  $('editReason').value = '';
  $('editHistory').replaceChildren(el('li', { textContent: 'Loading...' }));
  $('editDialog').showModal();
  try {
    const edits = await getDocs(query(collection(db, 'entries', shift.id, 'edits'), orderBy('at')));
    $('editHistory').replaceChildren(...(edits.empty
      ? [el('li', { textContent: 'No changes yet.' })]
      : edits.docs.map((d) => {
        const e = d.data();
        return el('li', { textContent: `${fmt(e.at.toDate())} by ${e.by}: ${e.reason}` });
      })));
  } catch (err) { showError(err); }
}

$('editCancel').onclick = () => $('editDialog').close();

$('editForm').onsubmit = async (e) => {
  e.preventDefault();
  const clockIn = new Date($('editIn').value);
  const clockOut = new Date($('editOut').value);
  if (!(clockOut > clockIn)) { alert('Clock out must be after clock in.'); return; }

  const entryRef = doc(db, 'entries', editing.id);
  const editRef = doc(collection(db, 'entries', editing.id, 'edits'));
  const b = writeBatch(db);
  b.update(entryRef, { clockIn: Timestamp.fromDate(clockIn), clockOut: Timestamp.fromDate(clockOut), lastEditId: editRef.id });
  b.set(editRef, {
    by: me.email,
    at: serverTimestamp(),
    reason: $('editReason').value.trim(),
    before: { clockIn: Timestamp.fromDate(editing.clockIn), clockOut: editing.clockOut ? Timestamp.fromDate(editing.clockOut) : null },
    after: { clockIn: Timestamp.fromDate(clockIn), clockOut: Timestamp.fromDate(clockOut) },
  });
  if (!editing.clockOut) b.delete(doc(db, 'status', editing.email)); // closing a forgotten shift
  try {
    await b.commit();
    $('editDialog').close();
    await runReport();
  } catch (err) { showError(err); }
};
