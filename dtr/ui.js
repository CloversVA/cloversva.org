// Small DOM helpers shared by the VA and admin screens.
import { BUSINESS_TZ, zonedInputValue, zonedToDate } from './report.js?v=12';

export const $ = (id) => document.getElementById(id);
export const show = (id, on = true) => { $(id).hidden = !on; };
export const asDate = (ts) => (ts ? ts.toDate() : null);

// ---------- Time zone for showing times (pay periods always use Eastern Time) ----------

export const TIME_ZONES = [
  ['America/New_York', 'Eastern (EST/EDT)'],
  ['America/Chicago', 'Central (CST/CDT)'],
  ['America/Denver', 'Mountain (MST/MDT)'],
  ['America/Phoenix', 'Arizona (MST)'],
  ['America/Los_Angeles', 'Pacific (PST/PDT)'],
  ['Asia/Manila', 'Philippines (PHT)'],
];
const TZ_KEY = 'cloversva.timeZone';

function savedTz() {
  try {
    const tz = localStorage.getItem(TZ_KEY);
    return TIME_ZONES.some(([id]) => id === tz) ? tz : BUSINESS_TZ;
  } catch { return BUSINESS_TZ; }
}
export let displayTz = savedTz();
export function setDisplayTz(tz) {
  displayTz = tz;
  try { localStorage.setItem(TZ_KEY, tz); } catch { /* private mode: lasts until reload */ }
}

export const fmt = (d) => d.toLocaleString('en-US', {
  timeZone: displayTz, month: 'short', day: 'numeric', year: 'numeric', hour: 'numeric', minute: '2-digit', timeZoneName: 'short',
});
// Day keys (YYYY-MM-DD) are calendar days, so format them without any time zone shift.
export const fmtDay = (day) => new Date(`${day}T00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', dateStyle: 'medium' });
export const fmtWeekday = (day) => new Date(`${day}T00:00Z`).toLocaleDateString('en-US', { timeZone: 'UTC', weekday: 'short', month: 'short', day: 'numeric' });

const pad = (n) => String(n).padStart(2, '0');
export const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
// Edit boxes show and read times in the chosen display time zone.
export const toDateTimeInput = (d) => zonedInputValue(d, displayTz);
export const fromDateTimeInput = (v) => zonedToDate(v.slice(0, 10), v.slice(11, 16), displayTz);

// Builds elements with textContent only, so names typed by people can never inject HTML.
export function el(tag, props = {}, ...kids) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...kids.filter((k) => k != null));
  return node;
}
export const cell = (...kids) => el('td', {}, ...kids);
export const numCell = (text) => el('td', { className: 'num', textContent: text });

export function showError(err) {
  console.error(err);
  $('error').textContent = err?.code === 'permission-denied'
    ? 'That action is not allowed. Reload the page and try again.'
    : `Something went wrong: ${err?.message ?? err}`;
  show('error');
}

// Opens a generated document in a new tab; it prints itself so it can be saved as PDF.
// Pass a tab opened before any waiting (await), or the browser may block it as a pop-up.
export function openDocument(html, w = window.open('', '_blank')) {
  if (!w) { showError({ message: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.' }); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

export function downloadBlob(filename, blob) {
  const a = el('a', { href: URL.createObjectURL(blob), download: filename });
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
}
export const downloadText = (filename, text, type = 'text/csv') => downloadBlob(filename, new Blob([text], { type }));

// SheetJS is only fetched the first time someone downloads an Excel file.
let xlsxLoading = null;
export function loadXlsx() {
  xlsxLoading ??= new Promise((resolve, reject) => {
    const s = el('script', { src: 'https://cdnjs.cloudflare.com/ajax/libs/xlsx/0.18.5/xlsx.full.min.js' });
    s.onload = () => resolve(window.XLSX);
    s.onerror = () => { xlsxLoading = null; reject(new Error('Could not load the Excel tool. Check your connection and try again.')); };
    document.head.append(s);
  });
  return xlsxLoading;
}
