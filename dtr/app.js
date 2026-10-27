import {
  GoogleAuthProvider, createUserWithEmailAndPassword, onAuthStateChanged,
  sendEmailVerification, sendPasswordResetEmail, signInWithEmailAndPassword, signInWithPopup, signOut,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-auth.js';
import {
  Timestamp, collection, deleteDoc, doc, getDoc, limit, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { startAdmin } from './admin.js?v=10';
import { setMyBirthday, startBoard } from './board.js?v=11';
import { startVaFiles } from './files.js?v=10';
import { myOvertime, overtimeCell, startVaRequests } from './requests.js?v=10';
import { coeHtml, payslipHtml } from './docs.js?v=10';
import { auth, db } from './firebase.js?v=2';
import {
  BUSINESS_TZ, calendarToday, dayKey, formatDuration, formatPhp, hmFromHours, payFor, periodRange, zonedToDate,
} from './report.js?v=10';
import {
  $, TIME_ZONES, asDate, cell, displayTz, el, fmt, fmtDay, numCell, openDocument, setDisplayTz, show, showError,
} from './ui.js?v=10';

const MY_SHIFTS_SHOWN = 14;
let mineDocs = [];

// Recent shifts, with an overtime button on any shift over 8 hours.
function renderMine() {
  $('mineRows').replaceChildren(...mineDocs.map((d) => {
    const s = d.data({ serverTimestamps: 'estimate' });
    const start = asDate(s.clockIn); const end = asDate(s.clockOut);
    return el('tr', {}, cell(fmt(start)), cell(end ? fmt(end) : 'Open'), cell(end ? formatDuration(end - start) : ''),
      end ? overtimeCell(d.id, end - start) : cell());
  }));
}

let me = null; // the signed-in person's allowed/{email} record, kept live
let myBank = null;
let myProfile = null;
let unsubs = [];
const track = (unsub) => unsubs.push(unsub);
function stopListening() { unsubs.forEach((u) => u()); unsubs = []; }

// One ticker keeps every running timer on the page current.
setInterval(() => {
  for (const node of document.querySelectorAll('[data-since]')) {
    node.textContent = formatDuration(Date.now() - Number(node.dataset.since));
  }
}, 1000);

// ---------- Side menu ----------

function setView(name) {
  for (const b of document.querySelectorAll('[data-view]')) {
    if (b.dataset.view === name) b.setAttribute('aria-current', 'page'); else b.removeAttribute('aria-current');
  }
  for (const p of document.querySelectorAll('[data-panel]')) p.hidden = p.dataset.panel !== name;
}
for (const b of document.querySelectorAll('[data-view]')) b.onclick = () => setView(b.dataset.view);

// Times show in Eastern Time unless the person picks another zone. The choice is saved to their account
// (so it follows them to other devices) and the page reloads to redraw every time.
function fillTzSelect() {
  $('tzSelect').replaceChildren(...TIME_ZONES.map(([id, label]) => el('option', { value: id, textContent: label, selected: id === displayTz })));
}
fillTzSelect();
$('tzSelect').onchange = async () => {
  setDisplayTz($('tzSelect').value);
  $('tzNote').textContent = 'Saving...';
  if (me) await setDoc(doc(db, 'prefs', me.email), { timeZone: displayTz }).catch(showError);
  location.reload();
};

async function loadSavedTz(email) {
  const snap = await getDoc(doc(db, 'prefs', email)).catch(() => null);
  const tz = snap?.exists() ? snap.data().timeZone : null;
  if (tz && tz !== displayTz) { setDisplayTz(tz); fillTzSelect(); }
}

// ---------- Google sign-in ----------

$('signInBtn').onclick = () => {
  signInWithPopup(auth, new GoogleAuthProvider()).catch((err) => {
    if (err.code === 'auth/popup-closed-by-user' || err.code === 'auth/cancelled-popup-request') return;
    if (err.code === 'auth/popup-blocked') {
      showError({ message: 'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.' });
    } else showError(err);
  });
};
$('signOut').onclick = () => signOut(auth);

// ---------- Email + password ----------

const AUTH_MESSAGES = {
  'auth/invalid-credential': 'Wrong email or password.',
  'auth/wrong-password': 'Wrong email or password.',
  'auth/user-not-found': 'Wrong email or password.',
  'auth/email-already-in-use': 'That email already has an account. Sign in instead, or use "Forgot password?".',
  'auth/weak-password': 'Use a password of at least 8 characters.',
  'auth/invalid-email': 'That email address does not look right.',
  'auth/missing-email': 'Type your email first.',
  'auth/too-many-requests': 'Too many tries. Wait a few minutes and try again.',
  'auth/operation-not-allowed': 'Email sign-in is not switched on yet. Use Google, or ask your manager.',
};
const authNote = (id, err) => { $(id).textContent = AUTH_MESSAGES[err?.code] ?? `Something went wrong: ${err?.message ?? err}`; };
const pwEmail = () => $('pwEmail').value.trim().toLowerCase();

$('pwForm').onsubmit = (e) => {
  e.preventDefault();
  $('pwNote').textContent = '';
  signInWithEmailAndPassword(auth, pwEmail(), $('pwPassword').value).catch((err) => authNote('pwNote', err));
};

$('pwCreate').onclick = async () => {
  $('pwNote').textContent = '';
  if (!$('pwForm').reportValidity()) return;
  try {
    const { user } = await createUserWithEmailAndPassword(auth, pwEmail(), $('pwPassword').value);
    await sendEmailVerification(user);
  } catch (err) { authNote('pwNote', err); }
};

$('pwForgot').onclick = async () => {
  try {
    await sendPasswordResetEmail(auth, pwEmail());
    $('pwNote').textContent = 'If that email has an account, a reset link is on its way. Check your spam folder too.';
  } catch (err) { authNote('pwNote', err); }
};

$('verifyResend').onclick = async () => {
  try {
    await sendEmailVerification(auth.currentUser);
    $('verifyNote').textContent = 'Sent again.';
  } catch (err) { authNote('verifyNote', err); }
};

// The verified flag only reaches the database rules through a fresh sign-in token.
$('verifyDone').onclick = async () => {
  await auth.currentUser.reload();
  if (!auth.currentUser.emailVerified) { $('verifyNote').textContent = 'Not verified yet. Click the link in the email first.'; return; }
  await auth.currentUser.getIdToken(true);
  location.reload();
};

// ---------- Who is signed in ----------

onAuthStateChanged(auth, async (user) => {
  stopListening();
  for (const id of ['signin', 'verify', 'pending', 'shell', 'who', 'error']) show(id, false);
  show('loading', false);
  if (!user) { show('signin'); return; }

  const email = user.email.toLowerCase();
  show('who'); $('whoName').textContent = email; $('whoClient').textContent = '';
  if (!user.emailVerified) {
    $('verifyEmail').textContent = email;
    show('verify');
    return;
  }
  try {
    const snap = await getDoc(doc(db, 'allowed', email));
    if (!snap.exists() || !snap.data().active) {
      $('pendingEmail').textContent = email;
      show('pending');
      const name = (user.displayName || email.split('@')[0]).slice(0, 100);
      setDoc(doc(db, 'requests', email), { name, at: serverTimestamp() }).catch((err) => {
        console.error(err);
        $('requestNote').textContent = 'We could not send your request automatically. Ask your manager to add this exact email, then reload this page.';
      });
      return;
    }
    me = { email, ...snap.data() };
    await loadSavedTz(email);
    show('shell');
    setView('clock');
    startVa();
    const admin = me.role === 'admin';
    for (const n of document.querySelectorAll('[data-admin]')) n.hidden = !admin;
    if (admin) startAdmin(me, track);
  } catch (err) { showError(err); }
});

// ---------- VA screens ----------

let openShift = null; // { entryId, since: Date } while on the clock

function renderMe() {
  $('whoName').textContent = me.name;
  $('whoClient').textContent = me.clientName || '';
  $('pClient').textContent = me.clientName || 'Not assigned yet';
  $('pPosition').textContent = me.position || 'Not set';
  $('pRate').textContent = me.phpRate ? `${formatPhp(me.phpRate)} per hour` : 'Not set';
  $('pStart').textContent = me.startDate ? fmtDay(me.startDate) : 'Not set';
  $('myRate').textContent = me.phpRate ? `${formatPhp(me.phpRate)} per hour` : 'Not set yet';
  renderCurrentPeriod();
}

// ---------- This pay period (an estimate until payroll makes the payslip) ----------

let payAnchor = '2026-10-11';
let periodShifts = [];
let periodUnsub = null;

function renderCurrentPeriod() {
  const [from, to] = periodRange('thisBiweek', calendarToday(BUSINESS_TZ), payAnchor).map((d) => dayKey(d));
  $('curPeriod').textContent = `${fmtDay(from)} to ${fmtDay(to)}`;
  // Approved overtime lets a shift count past 8 hours, same as in payroll.
  const withOt = periodShifts.map((x) => ({ ...x, otHours: myOvertime.get(x.id)?.status === 'approved' ? myOvertime.get(x.id).extraHours : 0 }));
  const { hours, amount } = payFor(withOt, me.phpRate || 0);
  $('curHours').textContent = `${hmFromHours(hours)} (${hours.toFixed(2)} h)`;
  $('curPay').textContent = me.phpRate ? formatPhp(amount) : 'Shown once your rate is set';
}

async function watchCurrentPeriod() {
  const cycle = await getDoc(doc(db, 'settings', 'payCycle')).catch(() => null);
  if (cycle?.exists()) payAnchor = cycle.data().anchor;
  const [first, last] = periodRange('thisBiweek', calendarToday(BUSINESS_TZ), payAnchor);
  const dayAfter = new Date(last.getFullYear(), last.getMonth(), last.getDate() + 1);
  periodUnsub?.();
  periodUnsub = onSnapshot(query(collection(db, 'entries'), where('email', '==', me.email),
    where('clockIn', '>=', Timestamp.fromDate(zonedToDate(dayKey(first), '00:00', BUSINESS_TZ))),
    where('clockIn', '<', Timestamp.fromDate(zonedToDate(dayKey(dayAfter), '00:00', BUSINESS_TZ))), orderBy('clockIn', 'desc')), (snap) => {
    periodShifts = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
      .map((x) => ({ id: x.id, clockIn: x.clockIn.toDate(), clockOut: asDate(x.clockOut) }));
    renderCurrentPeriod();
  }, showError);
  track(() => periodUnsub?.());
}

function startVa() {
  renderMe();
  watchCurrentPeriod();
  startBoard(me, track, me.role === 'admin');
  startVaFiles(me, track);
  startVaRequests(me, track, () => { renderMine(); renderCurrentPeriod(); });

  // Keep my record live so a rate or client change by an admin shows up without a reload.
  track(onSnapshot(doc(db, 'allowed', me.email), (snap) => {
    if (!snap.exists() || !snap.data().active) { location.reload(); return; }
    me = { email: me.email, ...snap.data() };
    renderMe();
  }, showError));

  track(onSnapshot(doc(db, 'status', me.email), (snap) => {
    const data = snap.data({ serverTimestamps: 'estimate' });
    openShift = data ? { entryId: data.entryId, since: data.clockIn.toDate() } : null;
    $('clockState').textContent = openShift ? `On the clock since ${fmt(openShift.since)}` : 'You are clocked out.';
    $('clockLabel').textContent = openShift ? 'Clock out' : 'Clock in';
    $('clockBtn').classList.toggle('on', !!openShift);
    const timer = $('clockTimer');
    if (openShift) timer.dataset.since = openShift.since.getTime(); else delete timer.dataset.since;
    timer.textContent = openShift ? formatDuration(Date.now() - openShift.since) : '';
  }, showError));

  const mine = query(collection(db, 'entries'), where('email', '==', me.email), orderBy('clockIn', 'desc'), limit(MY_SHIFTS_SHOWN));
  track(onSnapshot(mine, (snap) => {
    mineDocs = snap.docs;
    renderMine();
  }, showError));

  track(onSnapshot(query(collection(db, 'payslips'), where('email', '==', me.email)), (snap) => {
    const slips = snap.docs.map((d) => d.data()).sort((a, b) => b.periodStart.localeCompare(a.periodStart));
    show('myPayslipsEmpty', slips.length === 0);
    $('myPayslipRows').replaceChildren(...slips.map((s) => {
      const btn = el('button', { textContent: 'Payslip PDF' });
      btn.onclick = () => openDocument(payslipHtml({ ...s, paidAt: asDate(s.paidAt) }, myBank));
      const status = s.status === 'paid'
        ? el('span', { className: 'pill paid', textContent: `Paid ${s.paidAt ? fmtDay(dayKey(s.paidAt.toDate(), BUSINESS_TZ)) : ''}` })
        : el('span', { className: 'pill pending', textContent: 'Pending' });
      return el('tr', {}, cell(`${fmtDay(s.periodStart)} to ${fmtDay(s.periodEnd)}`), numCell(s.hours.toFixed(2)),
        numCell(formatPhp(s.phpRate)), numCell(formatPhp(s.amount)), cell(status), cell(btn));
    }));
  }, showError));

  track(onSnapshot(query(collection(db, 'coeRequests'), where('email', '==', me.email)), (snap) => {
    const requests = snap.docs.map((d) => d.data({ serverTimestamps: 'estimate' }))
      .sort((a, b) => b.requestedAt.toMillis() - a.requestedAt.toMillis());
    show('myCoeEmpty', requests.length === 0);
    $('myCoeRows').replaceChildren(...requests.map((r) => {
      const label = { pending: 'Waiting for approval', approved: `Approved ${r.issuedOn ? fmtDay(r.issuedOn) : ''}`, denied: 'Not approved' }[r.status];
      const status = el('span', { className: `pill ${r.status === 'approved' ? 'paid' : 'pending'}`, textContent: label });
      let action = null;
      if (r.status === 'approved') {
        action = el('button', { className: 'primary', textContent: 'View / Download' });
        action.onclick = () => openDocument(coeHtml({
          name: r.fullName, position: r.position, startDate: r.startDate, purpose: r.purpose, issuedOn: r.issuedOn, signatureUrl: r.signature,
        }));
      }
      return el('tr', {}, cell(fmt(r.requestedAt.toDate())), cell(r.purpose), cell(status), cell(action));
    }));
  }, showError));

  getDoc(doc(db, 'profiles', me.email)).then((snap) => {
    myProfile = snap.exists() ? snap.data() : null;
    $('pfName').value = myProfile?.fullName ?? me.name;
    lockFullName(!!myProfile?.fullName);
    $('pfBirth').value = myProfile?.birthDate ?? '';
    $('pfAddress').value = myProfile?.address ?? '';
    $('pfPhone').value = myProfile?.phone ?? '';
    setMyBirthday(myProfile?.birthDate ? myProfile.birthDate.slice(5) : null);
  }).catch(showError);

  getDoc(doc(db, 'bank', me.email)).then((snap) => {
    myBank = snap.exists() ? snap.data() : null;
    $('bankName').value = myBank?.bankName ?? '';
    $('bankAccountName').value = myBank?.accountName ?? '';
    $('bankAccountNumber').value = myBank?.accountNumber ?? '';
  }).catch(showError);
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
      b.set(entryRef, { email: me.email, name: me.name, clockIn: serverTimestamp(), clockOut: null, client: me.clientName ?? '' });
      b.set(statusRef, { entryId: entryRef.id, clockIn: serverTimestamp(), name: me.name });
    }
    await b.commit();
  } catch (err) { showError(err); } finally { btn.disabled = false; }
};

// Once saved, only an admin may change the full name (the database rules enforce this too).
function lockFullName(locked) {
  $('pfName').readOnly = locked;
  show('pfNameNote', locked);
}

$('profileForm').onsubmit = async (e) => {
  e.preventDefault();
  const profile = {
    fullName: $('pfName').value.trim(),
    birthDate: $('pfBirth').value,
    address: $('pfAddress').value.trim(),
    phone: $('pfPhone').value.trim(),
  };
  try {
    await setDoc(doc(db, 'profiles', me.email), profile);
    // Only the month and day go on the shared board, never the year.
    if (profile.birthDate) await setDoc(doc(db, 'birthdays', me.email), { name: me.name, monthDay: profile.birthDate.slice(5) });
    else await deleteDoc(doc(db, 'birthdays', me.email)).catch(() => {});
    setMyBirthday(profile.birthDate ? profile.birthDate.slice(5) : null);
    myProfile = profile;
    lockFullName(true);
    $('profileNote').textContent = 'Saved.';
  } catch (err) { showError(err); }
};

$('bankForm').onsubmit = async (e) => {
  e.preventDefault();
  const bank = {
    bankName: $('bankName').value.trim(),
    accountName: $('bankAccountName').value.trim(),
    accountNumber: $('bankAccountNumber').value.trim(),
  };
  try {
    await setDoc(doc(db, 'bank', me.email), bank);
    myBank = bank;
    $('bankNote').textContent = 'Saved.';
  } catch (err) { showError(err); }
};

$('coeForm').onsubmit = async (e) => {
  e.preventDefault();
  const purpose = $('coePurpose').value.trim();
  if (purpose.length < 3) { $('coeNote').textContent = 'Please write a reason (at least 3 characters).'; return; }
  try {
    await setDoc(doc(collection(db, 'coeRequests')), { email: me.email, name: me.name, purpose, status: 'pending', requestedAt: serverTimestamp() });
    e.target.reset();
    $('coeNote').textContent = 'Request sent. You will see it below once approved.';
  } catch (err) { showError(err); }
};
