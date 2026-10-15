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
    default: throw new Error(`Unknown period "${kind}"; expected thisWeek, lastWeek, thisMonth or lastMonth`);
  }
}
