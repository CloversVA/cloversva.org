// Pure helpers, shared by the browser and the tests. Shifts are {email, name, clockIn: Date, clockOut: Date|null}.

const MS_PER_HOUR = 3_600_000;

export function formatDuration(ms) {
  const totalMinutes = Math.max(0, Math.floor(ms / 60_000));
  const h = Math.floor(totalMinutes / 60);
  const m = String(totalMinutes % 60).padStart(2, '0');
  return `${h}h ${m}m`;
}

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

function csvCell(value) {
  let s = String(value ?? '');
  // A leading = + - @ makes Excel run the cell as a formula; neutralise it.
  if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function toCsv(shifts, formatDate = (d) => d.toISOString()) {
  const header = ['Name', 'Email', 'Clock in', 'Clock out', 'Hours'];
  const lines = shifts.map((s) => [
    s.name,
    s.email,
    formatDate(s.clockIn),
    s.clockOut ? formatDate(s.clockOut) : '',
    s.clockOut ? ((s.clockOut - s.clockIn) / MS_PER_HOUR).toFixed(2) : '',
  ]);
  return [header, ...lines].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}

export function totalsToCsv(summary) {
  const lines = summary.map((r) => [r.name, r.email, String(r.shifts), r.hours.toFixed(2), r.open ? String(r.open) : '']);
  return [['Name', 'Email', 'Shifts', 'Total hours', 'Still open'], ...lines].map((cols) => cols.map(csvCell).join(',')).join('\r\n');
}

// Payroll periods as [firstDay, lastDay] local dates. Weeks run Monday to Sunday.
export function periodRange(kind, today = new Date()) {
  const y = today.getFullYear(); const m = today.getMonth(); const d = today.getDate();
  const monday = d - ((today.getDay() + 6) % 7);
  switch (kind) {
    case 'thisWeek': return [new Date(y, m, monday), new Date(y, m, monday + 6)];
    case 'lastWeek': return [new Date(y, m, monday - 7), new Date(y, m, monday - 1)];
    case 'thisMonth': return [new Date(y, m, 1), new Date(y, m + 1, 0)];
    case 'lastMonth': return [new Date(y, m - 1, 1), new Date(y, m, 0)];
    // Pay periods: the 1st to the 15th, and the 16th to the end of the month.
    case 'thisHalf': return d <= 15 ? [new Date(y, m, 1), new Date(y, m, 15)] : [new Date(y, m, 16), new Date(y, m + 1, 0)];
    case 'lastHalf': return d <= 15 ? [new Date(y, m - 1, 16), new Date(y, m, 0)] : [new Date(y, m, 1), new Date(y, m, 15)];
    default: throw new Error(`Unknown period "${kind}"; expected thisWeek, lastWeek, thisMonth, lastMonth, thisHalf or lastHalf`);
  }
}

export const round2 = (n) => Math.round((n + Number.EPSILON) * 100) / 100;

// Local calendar day as YYYY-MM-DD (the form date inputs and payslip ids use).
export function dayKey(d) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Hours are rounded to 2 decimals first so the pay a VA sees is exactly hours x rate.
export function payFor(shifts, rate) {
  const ms = shifts.filter((s) => s.clockOut).reduce((sum, s) => sum + (s.clockOut - s.clockIn), 0);
  const hours = round2(ms / MS_PER_HOUR);
  return { hours, amount: round2(hours * rate) };
}

// One invoice line per VA per day, in date order.
export function invoiceLines(shifts) {
  const lines = new Map();
  for (const s of shifts) {
    if (!s.clockOut) continue;
    const key = `${dayKey(s.clockIn)}|${s.email}`;
    const line = lines.get(key) ?? { day: dayKey(s.clockIn), email: s.email, ms: 0 };
    line.ms += s.clockOut - s.clockIn;
    lines.set(key, line);
  }
  return [...lines.values()]
    .map(({ ms, ...l }) => ({ ...l, hours: round2(ms / MS_PER_HOUR) }))
    .sort((a, b) => a.day.localeCompare(b.day) || a.email.localeCompare(b.email));
}

const php = new Intl.NumberFormat('en-PH', { style: 'currency', currency: 'PHP' });
const usd = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });
export const formatPhp = (n) => php.format(n);
export const formatUsd = (n) => usd.format(n);

// For the printable documents, which are built as HTML text.
export function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

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
