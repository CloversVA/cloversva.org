// Consultation booking on the contact page: a calendar of open call times, kept in sync for every visitor.
// Booked times live in the Firestore "bookedSlots" collection (project va-time-tracker-fabd7). Each record holds
// only the time, never the visitor's name or email; their details still go to the team by email (Web3Forms).
import { firebaseConfig } from './dtr/firebase-config.js?v=2';
import { dayKey, zonedToDate } from './dtr/report.js?v=13';

// ---- Call hours: change these to change what can be booked ----
const TZ = 'America/New_York'; // call times are set in US Eastern Time
const FIRST_CALL = '09:00';     // first start time of the day
const LAST_CALL = '16:30';      // last start time of the day
const CALL_MINUTES = 30;        // length of each call slot
const WORK_DAYS = [1, 2, 3, 4, 5]; // Monday to Friday (0 = Sunday)
const DAYS_AHEAD = 21;          // how far ahead people can book
const NOTICE_HOURS = 24;        // earliest booking is this many hours from now

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || TZ;
const slotId = (date) => date.toISOString().slice(0, 16).replace(':', '') + 'Z'; // e.g. 2026-11-10T1400Z

const fmtTime = (d, tz) => d.toLocaleTimeString('en-US', { timeZone: tz, hour: 'numeric', minute: '2-digit' });
const fmtDate = (d, tz) => d.toLocaleDateString('en-US', { timeZone: tz, weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
const tzName = (d, tz) => d.toLocaleTimeString('en-US', { timeZone: tz, timeZoneName: 'short' }).split(' ').pop();

let booked = new Set();   // slot ids already taken
let live = false;         // true once booked times have loaded from the database
let chosen = null;        // Date of the picked slot
let chosenDay = null;
let viewMonth = null;      // YYYY-MM shown in the calendar
let offlineNow = false;   // booked times could not be loaded
let db = null;
let fs = null; // the Firestore functions, loaded after the calendar is on screen

// Every bookable slot from now + notice to DAYS_AHEAD days out, grouped by Eastern Time day.
function allDays() {
  const now = Date.now();
  const earliest = now + NOTICE_HOURS * 3_600_000;
  const days = [];
  for (let i = 0; i <= DAYS_AHEAD; i += 1) {
    const day = dayKey(new Date(now + i * 86_400_000), TZ);
    const weekday = new Date(`${day}T12:00:00Z`).getUTCDay();
    if (!WORK_DAYS.includes(weekday) || days.some((d) => d.day === day)) continue;
    const slots = [];
    const [h0, m0] = FIRST_CALL.split(':').map(Number);
    const [h1, m1] = LAST_CALL.split(':').map(Number);
    for (let t = h0 * 60 + m0; t <= h1 * 60 + m1; t += CALL_MINUTES) {
      const at = zonedToDate(day, `${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}`, TZ);
      if (at.getTime() >= earliest) slots.push(at);
    }
    if (slots.length) days.push({ day, slots });
  }
  return days;
}

function render() {
  const days = allDays();
  if (!days.some((d) => d.day === chosenDay)) chosenDay = (days.find((d) => d.slots.some((s) => !booked.has(slotId(s)))) ?? days[0])?.day ?? null;
  if (chosen && booked.has(slotId(chosen))) {
    chosen = null;
    $('bkNote').textContent = 'Sorry, the time you picked was just booked by someone else. Please choose another time.';
    $('bkNote').className = 'bk-note warn';
  }

  renderCalendar(days);

  const today = days.find((d) => d.day === chosenDay);
  $('bkDayTitle').textContent = today ? fmtDate(new Date(`${today.day}T12:00:00Z`), 'UTC') : 'No times available';
  $('bkTimes').replaceChildren(...(today?.slots ?? []).map((at) => {
    const taken = booked.has(slotId(at));
    const isChosen = chosen && at.getTime() === chosen.getTime();
    const b = el('button', { type: 'button', className: `bk-time${isChosen ? ' on' : ''}${taken ? ' taken' : ''}`, disabled: taken },
      el('strong', { textContent: fmtTime(at, TZ) }),
      el('span', { textContent: taken ? 'Booked' : (visitorTz !== TZ ? `${fmtTime(at, visitorTz)} your time` : 'Available') }));
    b.ariaPressed = String(Boolean(isChosen));
    b.dataset.slot = slotId(at);
    b.ariaLabel = `${fmtTime(at, TZ)} Eastern Time${taken ? ', already booked' : ''}`;
    b.onclick = () => pick(at);
    return b;
  }));
  updateFields();
}

// A compact month calendar (Sunday to Saturday), like Google Calendar's: days from the months before and after
// fill the first and last weeks in grey. Only days with open call times can be clicked.
function renderCalendar(days) {
  const byDay = new Map(days.map((d) => [d.day, d.slots.filter((s) => !booked.has(slotId(s))).length]));
  const months = [...new Set(days.map((d) => d.day.slice(0, 7)))];
  if (!months.length) { $('bkCal').replaceChildren(el('p', { className: 'bk-note', textContent: 'No call times are open right now. Please email us.' })); return; }
  if (!months.includes(viewMonth)) viewMonth = (chosenDay ?? days[0].day).slice(0, 7);
  const [y, m] = viewMonth.split('-').map(Number);
  const first = new Date(Date.UTC(y, m - 1, 1));
  const today = dayKey(new Date(), TZ);
  const at = months.indexOf(viewMonth);

  const nav = (dir, label, path) => {
    const b = el('button', { type: 'button', className: 'bk-nav', ariaLabel: label, disabled: !months[at + dir] });
    b.innerHTML = `<svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="${path}" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
    b.onclick = () => { viewMonth = months[at + dir]; render(); };
    return b;
  };
  const head = el('div', { className: 'bk-cal-head' },
    el('strong', { textContent: first.toLocaleDateString('en-US', { month: 'long', year: 'numeric', timeZone: 'UTC' }) }),
    el('div', { className: 'bk-navs' }, nav(-1, 'Previous month', 'M15 6L9 12L15 18'), nav(1, 'Next month', 'M9 6L15 12L9 18')));
  const dow = el('div', { className: 'bk-grid bk-dow-row', ariaHidden: 'true' }, ...['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((d) => el('span', { textContent: d })));

  // Always six weeks, starting on the Sunday on or before the 1st.
  const cells = [];
  const startMs = first.getTime() - first.getUTCDay() * 86_400_000;
  for (let i = 0; i < 42; i += 1) {
    const date = new Date(startMs + i * 86_400_000);
    const day = date.toISOString().slice(0, 10);
    const outside = day.slice(0, 7) !== viewMonth;
    const free = byDay.get(day);
    const open = free > 0 && !outside;
    const b = el('button', {
      type: 'button', disabled: !open, textContent: String(date.getUTCDate()),
      className: ['bk-date', open && 'open', outside && 'outside', free === 0 && 'full', day === today && 'today', day === chosenDay && !outside && 'on']
        .filter(Boolean).join(' '),
    });
    const label = fmtDate(new Date(`${day}T12:00:00Z`), 'UTC');
    b.ariaLabel = open ? `${label}, ${free} times open` : free === 0 ? `${label}, fully booked` : `${label}, not available`;
    b.ariaPressed = String(day === chosenDay);
    if (free === 0) b.title = 'Fully booked';
    if (open) b.title = `${free} time${free === 1 ? '' : 's'} open`;
    b.onclick = () => { chosenDay = day; render(); };
    cells.push(b);
  }
  $('bkCal').replaceChildren(head, dow, el('div', { className: 'bk-grid', role: 'group', ariaLabel: 'Days' }, ...cells));
}

function pick(at) {
  chosen = at;
  $('bkNote').className = 'bk-note';
  $('bkNote').textContent = '';
  $('bookingField').classList.remove('invalid');
  render();
}

function describe(at) {
  const et = `${fmtDate(at, TZ)}, ${fmtTime(at, TZ)} ${tzName(at, TZ)}`;
  const local = `${fmtDate(at, visitorTz)}, ${fmtTime(at, visitorTz)} ${tzName(at, visitorTz)}`;
  return { et, local };
}

function updateFields() {
  const d = chosen ? describe(chosen) : null;
  $('bkTimeEt').value = d?.et ?? '';
  $('bkTimeLocal').value = d ? `${d.local} (${visitorTz})` : '';
  $('bkSummary').textContent = d
    ? `Your call: ${d.et}${visitorTz !== TZ ? ` (${d.local} your time)` : ''}. ${CALL_MINUTES} minutes.`
    : 'Pick a day, then a time.';
  $('bkSummary').classList.toggle('picked', Boolean(d));
  // The "couldn't check" note only shows until a time is picked.
  $('bkOffline').hidden = !offlineNow || Boolean(d);
}

// Called by the form just before it sends. Holds the slot so nobody else can take it,
// and stops with a message if someone booked it first.
async function reserve() {
  if (!chosen) {
    $('bookingField').classList.add('invalid');
    $('bookingField').scrollIntoView({ behavior: 'smooth', block: 'center' });
    throw new Error('Please choose a day and time for your call.');
  }
  if (!db || !live) return describe(chosen); // availability could not be checked: the team confirms the time by email
  const at = chosen;
  const ref = fs.doc(db, 'bookedSlots', slotId(at));
  try {
    await fs.runTransaction(db, async (t) => {
      if ((await t.get(ref)).exists()) throw Object.assign(new Error('taken'), { code: 'taken' });
      t.set(ref, { at: fs.Timestamp.fromDate(at), createdAt: fs.serverTimestamp() });
    });
  } catch (err) {
    if (err.code === 'taken' || err.code === 'permission-denied') {
      booked.add(slotId(at));
      render();
      $('bookingField').scrollIntoView({ behavior: 'smooth', block: 'center' });
      throw new Error('That time was just booked by someone else. Please pick another time');
    }
    throw err;
  }
  return describe(at);
}

function reset() { chosen = null; render(); }

// The calendar shows straight away; booked times fill in once the database answers.
async function start() {
  render();
  setInterval(render, 5 * 60_000); // drop times that pass the notice window while the page is open
  const offline = (err) => {
    // Not allowed yet (database rules) or no connection: people can still ask for a time, and the team confirms it.
    console.warn('Could not load booked times.', err);
    live = false;
    offlineNow = true;
    updateFields();
  };
  try {
    const [{ initializeApp }, firestore] = await Promise.all([
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-app.js'),
      import('https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js'),
    ]);
    fs = firestore;
    const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);
    db = fs.getFirestore(initializeApp(LOCAL ? { apiKey: 'demo-key', projectId: 'demo-vatime' } : firebaseConfig, 'booking'));
    if (LOCAL) fs.connectFirestoreEmulator(db, '127.0.0.1', 8080);
  } catch (err) { offline(err); return; }
  const from = fs.Timestamp.fromDate(new Date());
  const to = fs.Timestamp.fromDate(new Date(Date.now() + (DAYS_AHEAD + 2) * 86_400_000));
  fs.onSnapshot(fs.query(fs.collection(db, 'bookedSlots'), fs.where('at', '>=', from), fs.where('at', '<=', to)), (snap) => {
    booked = new Set(snap.docs.map((d) => d.id));
    live = true;
    offlineNow = false;
    render();
  }, offline);
}

window.cloversBooking = { reserve, reset };
start();
