// Printable documents (payslip, invoice, certificate, timesheet), opened in a new tab where
// the browser's "Save as PDF" turns them into files. Every value goes through esc().
import { dayKey, esc, formatPhp, formatUsd, round2 } from './report.js?v=2';

export const COMPANY = {
  legalName: 'Clovers Virtual Assistance Services',
  shortName: 'CLOVERS VA',
  phone: '09201568952',
  email: 'support@cloverva.org',
  signatory: 'Diana A. Jaime',
  signatoryTitle: 'Founder',
  place: 'Binangonan, Rizal, Philippines',
};

const asset = (name) => new URL(`../images/${name}`, location.href).href;
const longDate = (d) => d.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
const fromDay = (day) => new Date(`${day}T00:00`);
const periodText = (start, end) => `${longDate(fromDay(start))} to ${longDate(fromDay(end))}`;
const masked = (acct) => (acct ? `•••• ${String(acct).slice(-4)}` : '');

function ordinal(n) {
  const tail = n % 100 >= 11 && n % 100 <= 13 ? 'th' : ({ 1: 'st', 2: 'nd', 3: 'rd' })[n % 10] ?? 'th';
  return `${n}${tail}`;
}

function page(title, body, extraCss = '') {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(title)}</title>
<link rel="preconnect" href="https://fonts.googleapis.com">
<link href="https://fonts.googleapis.com/css2?family=Poppins:wght@400;600;700&family=Inter:wght@400;600&display=swap" rel="stylesheet">
<style>
  @page { size: A4; margin: 14mm; }
  * { box-sizing: border-box; -webkit-print-color-adjust: exact; print-color-adjust: exact; }
  body { margin: 0; font: 14px/1.5 Inter, system-ui, sans-serif; color: #152318; background: #fff; }
  .sheet { position: relative; max-width: 800px; margin: 0 auto; padding: 24px; }
  .watermark { position: absolute; inset: 160px 0 auto; margin: auto; width: 60%; opacity: .07; pointer-events: none; z-index: 0; }
  .sheet > *:not(.watermark) { position: relative; z-index: 1; }
  .logo { width: 260px; }
  h1 { font-family: Poppins, sans-serif; letter-spacing: .3em; color: #81be39; text-align: center; margin: 24px 0; }
  .label { font-family: Poppins, sans-serif; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; font-size: 12px; color: #33453a; }
  table.grid { width: 100%; border-collapse: collapse; margin: 20px 0; }
  .grid th { background: #344f1f; color: #fff; font-family: Poppins, sans-serif; padding: 10px 8px; text-align: left; }
  .grid td { border: 1px solid #d9e0d4; padding: 8px; }
  .grid tfoot td { background: #344f1f; color: #fff; font-weight: 700; }
  .num { text-align: right; white-space: nowrap; }
  .meta td { padding: 2px 16px 2px 0; vertical-align: top; }
  .footer { text-align: center; margin-top: 40px; font-family: Poppins, sans-serif; font-weight: 600; letter-spacing: .06em; }
  .footer .thanks { color: #81be39; }
  .footer .contact { color: #0a5a2e; }
  .sign { margin-top: 48px; }
  .sign .line { width: 240px; border-bottom: 1px solid #152318; height: 36px; }
  .toolbar { text-align: center; padding: 12px; background: #eef6e2; }
  .toolbar button { font: 600 14px Poppins, sans-serif; padding: 8px 18px; border-radius: 8px; border: 0; background: #0a5a2e; color: #fff; cursor: pointer; }
  @media print { .toolbar { display: none; } }
  ${extraCss}
</style></head><body>
<div class="toolbar"><button onclick="print()">Print / Save as PDF</button></div>
<div class="sheet"><img class="watermark" src="${asset('clover-icon.png')}" alt="">${body}</div>
<script>addEventListener('load', () => setTimeout(print, 300));</script>
</body></html>`;
}

const footer = `<div class="footer"><div class="thanks">THANK YOU FOR YOUR BUSINESS</div>
<div class="contact">${esc(COMPANY.shortName)}, ${esc(COMPANY.phone)} - ${esc(COMPANY.email)}</div></div>`;

// slip: payslip doc data; bank: the VA's {bankName, accountName, accountNumber} or null.
export function payslipHtml(slip, bank) {
  const paid = slip.status === 'paid' && slip.paidAt;
  return page(`Payslip ${slip.periodStart} ${slip.name}`, `
<img class="logo" src="${asset('logo-transparent.png')}" alt="Clovers Virtual Assistance">
<h1>PAYSLIP</h1>
<table class="meta">
  <tr><td class="label">Employee</td><td>${esc(slip.name)}</td><td class="label">Pay period</td><td>${esc(periodText(slip.periodStart, slip.periodEnd))}</td></tr>
  <tr><td class="label">Position</td><td>${esc(slip.position || '-')}</td><td class="label">Status</td><td>${paid ? `Paid on ${esc(longDate(slip.paidAt))}` : 'Pending payout'}</td></tr>
  <tr><td class="label">Client</td><td>${esc(slip.clientName || '-')}</td><td></td><td></td></tr>
</table>
<table class="grid">
  <thead><tr><th>Description</th><th class="num">Hours</th><th class="num">Rate (PHP/hr)</th><th class="num">Amount (PHP)</th></tr></thead>
  <tbody><tr><td>Virtual assistance services${slip.clientName ? ` for ${esc(slip.clientName)}` : ''}</td>
    <td class="num">${slip.hours.toFixed(2)}</td><td class="num">${esc(formatPhp(slip.phpRate))}</td><td class="num">${esc(formatPhp(slip.amount))}</td></tr></tbody>
  <tfoot><tr><td>TOTAL</td><td class="num">${slip.hours.toFixed(2)}</td><td></td><td class="num">${esc(formatPhp(slip.amount))}</td></tr></tfoot>
</table>
<p class="label">Paid to</p>
${bank ? `<table class="meta">
  <tr><td>Bank</td><td>: ${esc(bank.bankName)}</td></tr>
  <tr><td>Account name</td><td>: ${esc(bank.accountName)}</td></tr>
  <tr><td>Account number</td><td>: ${esc(masked(bank.accountNumber))}</td></tr>
</table>` : '<p>No bank details on file yet.</p>'}
${footer}`);
}

// lines: [{day, name, position, usdRate, hours}]; company: settings/company or {}.
export function invoiceHtml({ clientName, invoiceDate, dueDate, lines, company }) {
  const rows = lines.map((l) => {
    const total = round2(l.hours * l.usdRate);
    return `<tr><td>${esc(l.name)}</td><td>${esc(l.position || '')}</td><td class="num">${esc(formatUsd(l.usdRate))}</td>
      <td>${esc(longDate(fromDay(l.day)))}</td><td class="num">${l.hours.toFixed(2)}</td><td class="num">${esc(formatUsd(total))}</td></tr>`;
  }).join('');
  const hours = round2(lines.reduce((s, l) => s + l.hours, 0));
  const amount = round2(lines.reduce((s, l) => s + round2(l.hours * l.usdRate), 0));
  return page(`Invoice ${clientName} ${dayKey(invoiceDate)}`, `
<img class="logo" src="${asset('logo-transparent.png')}" alt="Clovers Virtual Assistance">
<table class="meta" style="margin-top:24px;width:100%">
  <tr><td class="label">Invoice date :</td><td>${esc(longDate(invoiceDate))}</td><td class="label">Bill to</td></tr>
  <tr><td class="label">Due date :</td><td>${esc(longDate(dueDate))}</td><td>${esc(clientName)}</td></tr>
</table>
<table class="grid">
  <thead><tr><th>Name</th><th>Position</th><th class="num">Rate ($)</th><th>Date</th><th class="num">Qty./Hrs.</th><th class="num">Total ($)</th></tr></thead>
  <tbody>${rows || '<tr><td colspan="6">No hours in this period.</td></tr>'}</tbody>
  <tfoot><tr><td colspan="4">TOTAL</td><td class="num">${hours.toFixed(2)}</td><td class="num">${esc(formatUsd(amount))}</td></tr></tfoot>
</table>
<div style="display:flex;justify-content:space-between;gap:24px;flex-wrap:wrap">
  <div><p class="label">Payment method</p><table class="meta">
    <tr><td>Bank</td><td>: ${esc(company.bankName || '')}</td></tr>
    <tr><td>Account name</td><td>: ${esc(company.accountName || '')}</td></tr>
    <tr><td>Account number</td><td>: ${esc(company.accountNumber || '')}</td></tr></table></div>
  <div class="sign"><div class="line"></div><div>${esc(COMPANY.signatory)}</div></div>
</div>
<p class="label" style="margin-top:24px">Terms and conditions</p>
<p>Please make the payment by the due date to the account above. We accept cloud-based financial operations platforms such as Wise Transfer and Bill.com.</p>
${footer}`);
}

export function coeHtml({ name, position, startDate, purpose, today = new Date() }) {
  const since = startDate ? longDate(fromDay(startDate)) : '____________';
  const month = today.toLocaleDateString('en-US', { month: 'long' });
  return page(`Certificate of Employment ${name}`, `
<h1 style="font-size:40px;margin-top:150px;text-decoration:underline;text-underline-offset:10px">CERTIFICATION</h1>
<p style="margin-top:48px;font-size:17px">TO WHOM THIS MAY CONCERN :</p>
<p class="body"><b>This is to certify</b> that <u>${esc(name)}</u> is a bona fide employee of <b>${esc(COMPANY.legalName)}</b>,
holding the position of <u>${esc(position || '____________')}</u>. He/She has been with us since <u>${esc(since)}</u> until <u>present</u>.</p>
<p class="body">This certification is issued upon request of the person concerned for <u>${esc(purpose)}</u>.</p>
<p class="body">Done on this ${ordinal(today.getDate())} day of ${esc(month)}, ${today.getFullYear()} in ${esc(COMPANY.place)}.</p>
<div class="sign"><div class="line"></div>
  <div>${esc(COMPANY.signatory.toUpperCase())}</div><div>${esc(COMPANY.signatoryTitle)}</div><div>${esc(COMPANY.legalName)}</div></div>
${footer}`, `
  .sheet { min-height: 1000px; }
  .sheet::before, .sheet::after { content: ""; position: absolute; width: 150px; height: 170px; background: linear-gradient(135deg, #0a5a2e, #0e7a37); z-index: 0; }
  .sheet::before { top: 0; left: 0; border-bottom-right-radius: 100% 80%; }
  .sheet::after { bottom: 0; right: 0; border-top-left-radius: 100% 80%; }
  .body { font: 18px/1.7 Georgia, 'Times New Roman', serif; margin: 20px 0 20px 32px; }
  .footer { text-align: left; }`);
}

// totals: summarize() rows plus clientName; shifts: [{name, clockIn, clockOut}].
export function timesheetHtml({ from, to, totals, shifts }) {
  const fmt = (d) => d.toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
  return page(`Timesheet ${from} to ${to}`, `
<img class="logo" src="${asset('logo-transparent.png')}" alt="Clovers Virtual Assistance">
<h1>TIMESHEET</h1>
<p style="text-align:center">${esc(periodText(from, to))}</p>
<table class="grid">
  <thead><tr><th>VA</th><th>Client</th><th class="num">Shifts</th><th class="num">Hours</th><th class="num">Still open</th></tr></thead>
  <tbody>${totals.map((r) => `<tr><td>${esc(r.name)}</td><td>${esc(r.clientName || '')}</td><td class="num">${r.shifts}</td>
    <td class="num">${r.hours.toFixed(2)}</td><td class="num">${r.open || ''}</td></tr>`).join('') || '<tr><td colspan="5">No shifts.</td></tr>'}</tbody>
</table>
<table class="grid">
  <thead><tr><th>VA</th><th>Clock in</th><th>Clock out</th><th class="num">Hours</th></tr></thead>
  <tbody>${shifts.map((s) => `<tr><td>${esc(s.name)}</td><td>${esc(fmt(s.clockIn))}</td><td>${s.clockOut ? esc(fmt(s.clockOut)) : 'Open'}</td>
    <td class="num">${s.clockOut ? ((s.clockOut - s.clockIn) / 3_600_000).toFixed(2) : ''}</td></tr>`).join('')}</tbody>
</table>
${footer}`);
}
