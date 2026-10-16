// Pure helpers, shared by the browser and the tests. Shifts are {email, name, clockIn: Date, clockOut: Date|null}.

const MS_PER_HOUR = 3_600_000;
const MS_PER_DAY = 86_400_000;

// Pay periods, daily hours and invoice dates follow Eastern Time (EST/EDT), whatever the viewer's clock says.
export const BUSINESS_TZ = 'America/New_York';

export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}h ${m}m`;
}

// Hours as H:MM (e.g. 8:05), the timesheet format.
export function formatHM(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  return `${Math.floor(totalMinutes / 60)}:${String(totalMinutes % 60).padStart(2, '0')}`;
}
export const hmFromHours = (hours) => formatHM(Math.round(hours * 60) * 60_000);

// ---------- Time zones ----------

function zonedParts(date, tz) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: tz, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(date);
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return { y: get('year'), m: get('month'), d: get('day'), h: get('hour'), mi: get('minute'), s: get('second') };
}

// How far the zone's wall clock is ahead of UTC at that instant, in ms.
function offsetMs(date, tz) {
  const p = zonedParts(date, tz);
  return Date.UTC(p.y, p.m - 1, p.d, p.h, p.mi, p.s) - Math.floor(date.getTime() / 1000) * 1000;
}

const pad2 = (n) => String(n).padStart(2, '0');

// Calendar day as YYYY-MM-DD: in time zone tz when given, otherwise the device's own.
export function dayKey(d, tz) {
  if (!tz) return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  const p = zonedParts(d, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}`;
}

// The instant when the wall clock in tz reads `day` at `time` (HH:MM).
export function zonedToDate(day, time, tz) {
  const [y, m, d] = day.split('-').map(Number);
  const [h, mi] = time.split(':').map(Number);
  const guess = Date.UTC(y, m - 1, d, h, mi);
  const first = guess - offsetMs(new Date(guess), tz);
  return new Date(guess - offsetMs(new Date(first), tz)); // second pass settles DST changeover days
}

// The value a <input type="datetime-local"> needs to show this instant in tz.
export function zonedInputValue(date, tz) {
  const p = zonedParts(date, tz);
  return `${p.y}-${pad2(p.m)}-${pad2(p.d)}T${pad2(p.h)}:${pad2(p.mi)}`;
}

// Today in tz, as a plain calendar date for periodRange.
export function calendarToday(tz, now = new Date()) {
  const [y, m, d] = dayKey(now, tz).split('-').map(Number);
  return new Date(y, m - 1, d);
}

// ---------- Periods ----------

// [firstDay, lastDay] as calendar dates. Weeks run Monday to Sunday.
// Bi-weekly pay periods repeat every 14 days counted from anchorDay (YYYY-MM-DD).
export function periodRange(kind, today = new Date(), anchorDay = '2026-10-11') {
  const y = today.getFullYear(); const m = today.getMonth(); const d = today.getDate();
  const monday = d - ((today.getDay() + 6) % 7);
  switch (kind) {
    case 'thisWeek': return [new Date(y, m, monday), new Date(y, m, monday + 6)];
    case 'lastWeek': return [new Date(y, m, monday - 7), new Date(y, m, monday - 1)];
    case 'thisMonth': return [new Date(y, m, 1), new Date(y, m + 1, 0)];
    case 'lastMonth': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    case 'thisBiweek':
    case 'lastBiweek': {
      const [ay, am, ad] = anchorDay.split('-').map(Number);
      const anchor = new Date(ay, am - 1, ad);
      const periods = Math.floor(Math.round((new Date(y, m, d) - anchor) / MS_PER_DAY) / 14) - (kind === 'lastBiweek' ? 1 : 0);
      const start = ad + periods * 14;
      return [new Date(ay, am - 1, start), new Date(ay, am - 1, start + 13)];
    }
    default: throw new Error(`Unknown period "${kind}"; expected thisWeek, lastWeek, thisMonth, lastMonth, thisBiweek or lastBiweek`);
  }
}

// The current pay period and the `back` before it, newest first: [{start, end}] as YYYY-MM-DD.
export function payPeriods(anchorDay, today, back = 8) {
  const [first] = periodRange('thisBiweek', today, anchorDay);
  return Array.from({ length: back + 1 }, (_, i) => {
    const start = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 14 * i);
    const end = new Date(start.getFullYear(), start.getMonth(), start.getDate() + 13);
    return { start: dayKey(start), end: dayKey(end) };
  });
}

// True when two YYYY-MM-DD ranges share at least one day.
export const periodsOverlap = (a, b) => a.start <= b.end && b.start <= a.end;

// ---------- Totals and pay ----------

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Totals per VA. Open shifts are counted separately, never added to hours.
export function summarize(shifts) {
  const byEmail = new Map();
  for (const s of shifts) {
    const row = byEmail.get(s.email) ?? { email: s.email, name: s.name, shifts: 0, hours: 0, open: 0 };
    if (s.clockOut) {
      row.shifts += 1;
      row.hours += (s.clockOut - s.clockIn) / MS_PER_HOUR;
    } else {
      row.open += 1;
    }
    byEmail.set(s.email, row);
  }
  return [...byEmail.values()].sort((a, b) => a.name.localeCompare(b.name));
}

// Closed-shift hours per Eastern calendar day, in date order: [{day, hours}].
export function dailyHours(shifts, tz = BUSINESS_TZ) {
  const byDay = new Map();
  for (const s of shifts) {
    if (!s.clockOut) continue;
    const day = dayKey(s.clockIn, tz);
    byDay.set(day, (byDay.get(day) ?? 0) + (s.clockOut - s.clockIn));
  }
  return [...byDay.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([day, ms]) => ({ day, hours: round2(ms / MS_PER_HOUR) }));
}

// Pay = total hours x rate, where total hours is the sum of the daily hours shown on the payslip,
// so a VA can check the arithmetic line by line.
export function payFor(shifts, rate, tz = BUSINESS_TZ) {
  const days = dailyHours(shifts, tz);
  const hours = round2(days.reduce((sum, d) => sum + d.hours, 0));
  return { hours, amount: round2(hours * rate), days };
}

// One invoice line per VA per day, in date order.
export function invoiceLines(shifts, tz = BUSINESS_TZ) {
  const byEmail = new Map();
  for (const s of shifts) byEmail.set(s.email, [...(byEmail.get(s.email) ?? []), s]);
  return [...byEmail.entries()]
    .flatMap(([email, theirs]) => dailyHours(theirs, tz).map((d) => ({ ...d, email })))
    .sort((a, b) => a.day.localeCompare(b.day) || a.email.localeCompare(b.email));
}

// ---------- Exports (CSV and Excel share the same rows) ----------

const shiftMs = (s) => (s.clockOut ? s.clockOut - s.clockIn : 0);

export function shiftRows(shifts, formatDate = (d) => d.toISOString()) {
  return [
    ['Name', 'Email', 'Clock in', 'Clock out', 'Hours (H:MM)', 'Hours (decimal)'],
    ...shifts.map((s) => [
      s.name, s.email, formatDate(s.clockIn), s.clockOut ? formatDate(s.clockOut) : '',
      s.clockOut ? formatHM(shiftMs(s)) : '', s.clockOut ? round2(shiftMs(s) / MS_PER_HOUR) : '',
    ]),
  ];
}

export function totalsRows(summary) {
  return [
    ['Name', 'Email', 'Shifts', 'Total hours (H:MM)', 'Total hours (decimal)', 'Still open'],
    ...summary.map((r) => [r.name, r.email, r.shifts, hmFromHours(r.hours), round2(r.hours), r.open || '']),
  ];
}

function csvCell(value) {
  let s = String(value ?? '');
  // A leading = + - @ makes Excel run the cell as a formula; neutralise it.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export const rowsToCsv = (rows) => rows.map((cols) => cols.map(csvCell).join(',')).join('\r\n');

// ---------- Formatting ----------

const php = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatPhp = (n) => php.format(n);
export const formatUsd = (n) => usd.format(n);

// For the printable documents, which are built as HTML text.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

// ---------- Timesheet table ----------

// Sorts shifts for the timesheet table. key: name | clockIn | clockOut | length; dir: 1 or -1.
// Open shifts (no clock-out) always sort last on clockOut and length, whichever the direction.
export function sortShifts(shifts, key, dir = 1) {
  const value = {
    name: (s) => s.name.toLowerCase(),
    clockIn: (s) => s.clockIn.getTime(),
    clockOut: (s) => (s.clockOut ? s.clockOut.getTime() : null),
    length: (s) => (s.clockOut ? s.clockOut - s.clockIn : null),
  }[key];
  if (!value) throw new Error(`Unknown sort "${key}"; expected name, clockIn, clockOut or length`);
  return [...shifts].sort((a, b) => {
    const x = value(a); const y = value(b);
    if (x === null || y === null) return x === y ? 0 : x === null ? 1 : -1;
    const c = typeof x === 'string' ? x.localeCompare(y) : x - y;
    return c * dir || a.clockIn - b.clockIn;
  });
}

export const matchesName = (shift, text) => shift.name.toLowerCase().includes(text.trim().toLowerCase());
