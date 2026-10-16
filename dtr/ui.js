// Small DOM helpers shared by the VA and admin screens.
export const $ = (id) => document.getElementById(id);
export const show = (id, on = true) => { $(id).hidden = !on; };
export const fmt = (d) => d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
export const fmtDay = (day) => new Date(`${day}T00:00`).toLocaleDateString([], { dateStyle: 'medium' });
export const asDate = (ts) => (ts ? ts.toDate() : null);

const pad = (n) => String(n).padStart(2, '0');
export const toDateInput = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
export const toDateTimeInput = (d) => `${toDateInput(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;

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
export function openDocument(html) {
  const w = window.open('', '_blank');
  if (!w) { showError({ message: 'Your browser blocked the new tab. Allow pop-ups for this site and try again.' }); return; }
  w.document.open();
  w.document.write(html);
  w.document.close();
}

export function downloadText(filename, text, type = 'text/csv') {
  const a = el('a', { href: URL.createObjectURL(new Blob([text], { type })), download: filename });
  a.click();
  URL.revokeObjectURL(a.href);
}
