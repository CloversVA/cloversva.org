import {
  Timestamp, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, updateDoc, where,
  writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { coeHtml, invoiceHtml, payslipHtml, timesheetHtml } from './docs.js?v=9';
import { setFileAudience, startAdminFiles } from './files.js?v=9';
import { db } from './firebase.js?v=2';
import {
  BUSINESS_TZ, calendarToday, dayKey, formatDuration, formatHM, formatPhp, formatUsd, hmFromHours, invoiceLines, matchesName,
  paidMs, payFor, payPeriods, periodRange, periodsOverlap, round2, round3, rowsToCsv, shiftRows, sortShifts, summarize, totalsRows,
  zonedToDate,
} from './report.js?v=9';
import { startAdminRequests } from './requests.js?v=9';
import {
  $, asDate, cell, downloadText, el, fmt, fmtDay, fmtWeekday, fromDateTimeInput, loadXlsx, numCell, openDocument, show, showError,
  toDateInput, toDateTimeInput,
} from './ui.js?v=9';

const DEFAULT_PAY_ANCHOR = '2026-10-11'; // a Sunday; admins can change it under Company details

const VA_FIELDS = ['name', 'role', 'active', 'clientName', 'position', 'phpRate', 'usdRate', 'startDate'];
const pick = (o) => Object.fromEntries(VA_FIELDS.filter((k) => o[k] !== undefined).map((k) => [k, o[k]]));

let me = null;
let vas = new Map(); // email -> allowed record, kept live

export function startAdmin(signedIn, track) {
  me = signedIn;

  track(onSnapshot(collection(db, 'status'), (snap) => {
    $('nowRows').replaceChildren(...snap.docs.map((d) => {
      const since = d.data({ serverTimestamps: 'estimate' }).clockIn.toDate();
      const timer = el('span', { textContent: formatDuration(Date.now() - since) });
      timer.dataset.since = since.getTime();
      return el('tr', {}, cell(d.data().name), cell(fmt(since)), cell(timer));
    }));
    show('nowEmpty', snap.empty);
  }, showError));

  track(onSnapshot(collection(db, 'requests'), renderRequests, showError));

  track(onSnapshot(collection(db, 'allowed'), (snap) => {
    vas = new Map(snap.docs.map((d) => [d.id, { email: d.id, ...d.data() }]));
    renderVas();
    setFileAudience([...vas.values()]);
    const clients = [...new Set([...vas.values()].map((v) => v.clientName).filter(Boolean))].sort();
    $('clientList').replaceChildren(...clients.map((c) => el('option', { value: c })));
    const current = $('invClient').value;
    $('invClient').replaceChildren(...clients.map((c) => el('option', { value: c, textContent: c })));
    if (clients.includes(current)) $('invClient').value = current;
  }, showError));

  track(onSnapshot(collection(db, 'coeRequests'), renderCoeRequests, showError));
  startAdminRequests(me, track, async (ids) => new Map(await Promise.all(ids.map(async (id) => {
    const snap = await getDoc(doc(db, 'entries', id));
    return [id, snap.exists() ? { clockIn: asDate(snap.data().clockIn), clockOut: asDate(snap.data().clockOut) } : null];
  }))));
  startAdminFiles(me, track);

  const due = calendarToday(BUSINESS_TZ); due.setDate(due.getDate() + 7);
  $('invDue').value = toDateInput(due);
  // Pay periods depend on the saved pay-cycle start date, so set them once it has loaded.
  loadCompany().finally(() => {
    setPeriod('ts', 'thisBiweek');
    fillPayPeriods();
    setPeriod('inv', 'lastBiweek');
  });
  loadSignature();
}

// ---------- Periods ----------

function setPeriod(prefix, kind) {
  const [from, to] = periodRange(kind, calendarToday(BUSINESS_TZ), payAnchor);
  $(`${prefix}From`).value = toDateInput(from);
  $(`${prefix}To`).value = toDateInput(to);
}

const AFTER_PERIOD = { ts: () => runTimesheet(), inv: () => {} };
for (const btn of document.querySelectorAll('[data-period]')) {
  btn.onclick = () => {
    setPeriod(btn.dataset.for, btn.dataset.period);
    Promise.resolve(AFTER_PERIOD[btn.dataset.for]()).catch(showError);
  };
}

const nextDay = (day) => new Date(Date.UTC(...day.split('-').map((n, i) => Number(n) - (i === 1 ? 1 : 0))) + 86_400_000).toISOString().slice(0, 10);

// Shifts that started between two YYYY-MM-DD days (Eastern Time), inclusive.
async function fetchShifts(fromDay, toDay) {
  const from = zonedToDate(fromDay, '00:00', BUSINESS_TZ);
  const to = zonedToDate(nextDay(toDay), '00:00', BUSINESS_TZ);
  const [snap, overtime] = await Promise.all([
    getDocs(query(collection(db, 'entries'),
      where('clockIn', '>=', Timestamp.fromDate(from)), where('clockIn', '<', Timestamp.fromDate(to)), orderBy('clockIn'))),
    getDocs(query(collection(db, 'overtime'), where('status', '==', 'approved'))),
  ]);
  // Approved overtime lets a shift count past 8 hours in timesheets, payroll and invoices.
  const approvedOt = new Map(overtime.docs.map((d) => [d.id, d.data().extraHours]));
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      id: d.id, email: s.email, name: s.name, client: s.client || vas.get(s.email)?.clientName || '',
      clockIn: asDate(s.clockIn), clockOut: asDate(s.clockOut), edited: !!s.lastEditId, raw: s, otHours: approvedOt.get(d.id) ?? 0,
    };
  });
}

// ---------- VAs and approvals ----------

function renderRequests(snap) {
  const waiting = snap.docs
    .map((d) => ({ email: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
    .sort((a, b) => b.at.toMillis() - a.at.toMillis());
  $('waitingCount').textContent = String(waiting.length);
  show('waitingCount', waiting.length > 0);
  show('requestsBox', waiting.length > 0);
  $('requestRows').replaceChildren(...waiting.map((r) => {
    const name = el('input', { value: r.name, maxLength: 100, required: true, ariaLabel: `Name for ${r.email}` });
    const approve = el('button', { className: 'primary', textContent: 'Approve' });
    const deny = el('button', { textContent: 'Deny' });
    approve.onclick = async () => {
      if (!name.value.trim()) { name.focus(); return; }
      approve.disabled = true;
      const b = writeBatch(db);
      b.set(doc(db, 'allowed', r.email), { name: name.value.trim(), role: 'va', active: true });
      b.delete(doc(db, 'requests', r.email));
      await b.commit().catch(showError);
      approve.disabled = false;
    };
    deny.onclick = () => {
      if (confirm(`Deny access for ${r.email}? They will see "not approved" and can ask again by signing in.`)) {
        deleteDoc(doc(db, 'requests', r.email)).catch(showError);
      }
    };
    return el('tr', {}, cell(name), cell(r.email), cell(fmt(r.at.toDate())), cell(approve, ' ', deny));
  }));
}

function renderVas() {
  const rows = [...vas.values()].sort((a, b) => a.name.localeCompare(b.name));
  $('vaRows').replaceChildren(...rows.map((va) => {
    const self = va.email === me.email;
    const edit = el('button', { textContent: 'Edit', disabled: self, title: self ? 'Another admin has to edit your own record' : '' });
    edit.onclick = () => openVaEditor(va);
    const toggle = el('button', { textContent: va.active ? 'Deactivate' : 'Reactivate', disabled: self });
    toggle.onclick = () => setDoc(doc(db, 'allowed', va.email), pick({ ...va, active: !va.active })).catch(showError);
    const who = el('div', {}, el('div', { textContent: va.name }), el('div', { className: 'muted', textContent: va.email }));
    return el('tr', {}, cell(who), cell(va.clientName || ''), cell(va.position || ''),
      numCell(va.phpRate ? formatPhp(va.phpRate) : ''), numCell(va.usdRate ? formatUsd(va.usdRate) : ''),
      cell(va.role === 'admin' ? 'Admin' : 'VA'), cell(va.active ? 'Active' : 'Deactivated'), cell(edit, ' ', toggle));
  }));
}

$('addForm').onsubmit = async (e) => {
  e.preventDefault();
  const email = $('newEmail').value.trim().toLowerCase();
  try {
    await setDoc(doc(db, 'allowed', email), { name: $('newName').value.trim(), role: $('newRole').value, active: true });
    e.target.reset();
  } catch (err) { showError(err); }
};

let editingVa = null;
let editingProfile = null;

function openVaEditor(va) {
  editingVa = va;
  $('vaDialogEmail').textContent = va.email;
  $('vaName').value = va.name;
  $('vaClient').value = va.clientName ?? '';
  $('vaPosition').value = va.position ?? '';
  $('vaPhp').value = va.phpRate ?? '';
  $('vaUsd').value = va.usdRate ?? '';
  $('vaStart').value = va.startDate ?? '';
  $('vaRole').value = va.role;
  $('vaProfile').replaceChildren(el('dd', { className: 'muted', textContent: 'Loading...' }));
  editingProfile = null;
  show('vaFullNameLabel', false);
  $('vaDialog').showModal();
  getDoc(doc(db, 'profiles', va.email)).then((snap) => {
    const p = snap.exists() ? snap.data() : null;
    editingProfile = p;
    if (!p) { $('vaProfile').replaceChildren(el('dd', { className: 'muted', textContent: 'Not filled in yet.' })); return; }
    $('vaFullName').value = p.fullName;
    show('vaFullNameLabel');
    const rows = [['Date of birth', p.birthDate ? fmtDay(p.birthDate) : ''], ['Address', p.address], ['Phone', p.phone]];
    $('vaProfile').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v || '-' })]));
  }).catch(showError);
}

$('vaCancel').onclick = () => $('vaDialog').close();

$('vaForm').onsubmit = async (e) => {
  e.preventDefault();
  // A rate typed with a comma or currency sign used to be saved silently as 0.
  if ($('vaPhp').validity.badInput || $('vaUsd').validity.badInput) {
    alert('Type each rate as a plain number, like 400 or 1000.50, without commas or ₱/$ signs.');
    return;
  }
  if (!(Number($('vaPhp').value) > 0) && $('vaRole').value === 'va'
    && !confirm(`${$('vaName').value} has no PHP hourly rate, so their payslips will show ₱0.00. Save anyway?`)) return;
  const record = {
    name: $('vaName').value.trim(),
    role: $('vaRole').value,
    active: editingVa.active,
    clientName: $('vaClient').value.trim(),
    position: $('vaPosition').value.trim(),
    phpRate: round2(Number($('vaPhp').value) || 0),
    usdRate: round3(Number($('vaUsd').value) || 0),
    startDate: $('vaStart').value,
  };
  try {
    await setDoc(doc(db, 'allowed', editingVa.email), record);
    const fullName = $('vaFullName').value.trim();
    if (editingProfile && fullName && fullName !== editingProfile.fullName) {
      await updateDoc(doc(db, 'profiles', editingVa.email), { fullName });
    }
    $('vaDialog').close();
  } catch (err) { showError(err); }
};

// ---------- Timesheets ----------

let tsShifts = [];
let tsSort = { key: 'clockIn', dir: 1 };

// The filtered, sorted shifts currently on screen; the CSV and PDF use exactly these.
const shownShifts = () => sortShifts(tsShifts.filter((s) => matchesName(s, $('tsFilter').value)), tsSort.key, tsSort.dir);
const totalsOf = (shifts) => summarize(shifts).map((r) => ({ ...r, clientName: vas.get(r.email)?.clientName || '' }));

let tsLeave = [];

async function runTimesheet() {
  const from = $('tsFrom').value; const to = $('tsTo').value;
  const [shifts, leave] = await Promise.all([
    fetchShifts(from, to),
    getDocs(query(collection(db, 'leaveRequests'), where('status', '==', 'approved'))),
  ]);
  tsShifts = shifts;
  tsLeave = leave.docs.map((d) => d.data())
    .filter((r) => periodsOverlap({ start: from, end: to }, { start: r.startDay, end: r.endDay }))
    .sort((a, b) => a.startDay.localeCompare(b.startDay));
  renderTimesheet();
}

function renderTimesheet() {
  const shown = shownShifts();
  $('totalRows').replaceChildren(...totalsOf(shown).map((r) =>
    el('tr', {}, cell(r.name), cell(r.clientName), numCell(String(r.shifts)), numCell(hmFromHours(r.hours)), numCell(hmFromHours(r.paidHours)), numCell(r.open ? String(r.open) : ''))));
  $('shiftRows').replaceChildren(...shown.map((s) => {
    const edit = el('button', { textContent: s.clockOut ? 'Fix' : 'Close shift' });
    edit.onclick = () => openShiftEditor(s);
    const del = el('button', { className: 'danger', textContent: 'Delete' });
    del.onclick = () => deleteShift(s);
    return el('tr', {}, cell(s.name), cell(fmt(s.clockIn)),
      cell(s.clockOut ? fmt(s.clockOut) : 'Open'), cell(s.clockOut ? formatHM(s.clockOut - s.clockIn) : ''),
      cell(s.clockOut ? formatHM(paidMs(s)) : '', s.otHours ? el('span', { className: 'muted', textContent: ` incl. ${s.otHours} h OT` }) : null),
      cell(edit, ' ', del, s.edited ? el('span', { className: 'muted', textContent: ' edited' }) : null));
  }));
  for (const b of document.querySelectorAll('button.sort')) {
    b.closest('th').setAttribute('aria-sort', b.dataset.sort !== tsSort.key ? 'none' : tsSort.dir === 1 ? 'ascending' : 'descending');
  }
  show('tsEmpty', tsShifts.length > 0 && shown.length === 0);
  const leave = tsLeave.filter((r) => matchesName(r, $('tsFilter').value));
  show('tsLeaveEmpty', leave.length === 0);
  $('tsLeaveRows').replaceChildren(...leave.map((r) => el('tr', {}, cell(r.name),
    cell(r.startDay === r.endDay ? fmtDay(r.startDay) : `${fmtDay(r.startDay)} to ${fmtDay(r.endDay)}`),
    cell(r.type === 'leave' ? 'Leave (unpaid)' : 'Absence (unpaid)'), cell(r.reason))));
  $('csvBtn').disabled = $('tsPrintBtn').disabled = $('xlsxBtn').disabled = shown.length === 0;
}

for (const b of document.querySelectorAll('button.sort')) {
  b.onclick = () => {
    tsSort = { key: b.dataset.sort, dir: tsSort.key === b.dataset.sort ? -tsSort.dir : 1 };
    renderTimesheet();
  };
}
$('tsFilter').oninput = () => renderTimesheet();

async function deleteShift(shift) {
  const when = `${shift.name}, ${fmt(shift.clockIn)}`;
  const reason = prompt(`Delete this shift?\n${when}\n\nWhy? (for example "duplicate login"). The shift is archived with your reason.`);
  if (reason === null) return;
  if (reason.trim().length < 3) { alert('Please give a reason of at least 3 characters.'); return; }
  const b = writeBatch(db);
  b.set(doc(db, 'deletedShifts', shift.id), { shift: shift.raw, by: me.email, at: serverTimestamp(), reason: reason.trim() });
  b.delete(doc(db, 'entries', shift.id));
  if (!shift.clockOut) b.delete(doc(db, 'status', shift.email)); // an open shift also takes the VA off the clock
  try {
    await b.commit();
    tsShifts = tsShifts.filter((s) => s.id !== shift.id);
    renderTimesheet();
  } catch (err) { showError(err); }
}

$('tsForm').onsubmit = (e) => { e.preventDefault(); runTimesheet().catch(showError); };

// Downloads cover exactly the filtered, sorted rows on screen (e.g. one VA when filtered by name).
const exportName = (ext) => {
  const who = $('tsFilter').value.trim().replace(/[^a-z0-9]+/gi, '-').toLowerCase();
  return `cloversva-hours_${$('tsFrom').value}_to_${$('tsTo').value}${who ? `_${who}` : ''}.${ext}`;
};

$('csvBtn').onclick = () => {
  const shown = shownShifts();
  downloadText(exportName('csv'), `${rowsToCsv(totalsRows(summarize(shown)))}\r\n\r\n${rowsToCsv(shiftRows(shown, fmt))}`);
};

$('xlsxBtn').onclick = async () => {
  const shown = shownShifts();
  try {
    const XLSX = await loadXlsx();
    const book = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(totalsRows(summarize(shown))), 'Totals');
    XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(shiftRows(shown, fmt)), 'Shifts');
    XLSX.writeFile(book, exportName('xlsx'));
  } catch (err) { showError(err); }
};

$('tsPrintBtn').onclick = () => {
  const shown = shownShifts();
  openDocument(timesheetHtml({ from: $('tsFrom').value, to: $('tsTo').value, totals: totalsOf(shown), shifts: shown, fmt }));
};

// ---------- Fix a shift ----------

let editingShift = null;

async function openShiftEditor(shift) {
  editingShift = shift;
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
  const clockIn = fromDateTimeInput($('editIn').value);
  const clockOut = fromDateTimeInput($('editOut').value);
  if (!(clockOut > clockIn)) { alert('Clock out must be after clock in.'); return; }

  const entryRef = doc(db, 'entries', editingShift.id);
  const editRef = doc(collection(db, 'entries', editingShift.id, 'edits'));
  const b = writeBatch(db);
  b.update(entryRef, { clockIn: Timestamp.fromDate(clockIn), clockOut: Timestamp.fromDate(clockOut), lastEditId: editRef.id });
  b.set(editRef, {
    by: me.email,
    at: serverTimestamp(),
    reason: $('editReason').value.trim(),
    before: { clockIn: Timestamp.fromDate(editingShift.clockIn), clockOut: editingShift.clockOut ? Timestamp.fromDate(editingShift.clockOut) : null },
    after: { clockIn: Timestamp.fromDate(clockIn), clockOut: Timestamp.fromDate(clockOut) },
  });
  if (!editingShift.clockOut) b.delete(doc(db, 'status', editingShift.email)); // closing a forgotten shift
  try {
    await b.commit();
    $('editDialog').close();
    await runTimesheet();
  } catch (err) { showError(err); }
};

// ---------- Payroll ----------

const slipId = (periodStart, email) => `${periodStart}_${email}`;
const stamp = () => ({ updatedBy: me.email, updatedAt: serverTimestamp() });

async function loadPayroll() {
  const from = $('payFrom').value; const to = $('payTo').value;
  const snap = await getDocs(query(collection(db, 'payslips'), where('periodStart', '==', from)));
  const slips = snap.docs.map((d) => d.data()).filter((s) => s.periodEnd === to).sort((a, b) => a.name.localeCompare(b.name));
  const banks = new Map(await Promise.all(slips.map(async (s) => {
    const b = await getDoc(doc(db, 'bank', s.email));
    return [s.email, b.exists() ? b.data() : null];
  })));
  show('payEmpty', slips.length === 0);
  const total = round2(slips.reduce((sum, s) => sum + s.amount, 0));
  $('payTotal').textContent = slips.length ? `Total: ${formatPhp(total)}` : '';
  $('payRows').replaceChildren(...slips.flatMap((s) => payrollRow(s, banks.get(s.email))));
}

function payrollRow(slip, bank) {
  const pending = slip.status === 'pending';
  const rate = el('input', { type: 'number', min: 0, max: 100000, step: 0.01, value: slip.phpRate, disabled: !pending, ariaLabel: `Rate for ${slip.name}` });
  const amount = numCell(formatPhp(slip.amount));
  rate.oninput = () => { amount.textContent = formatPhp(round2(slip.hours * (Number(rate.value) || 0))); };

  const save = el('button', { textContent: 'Save rate', hidden: !pending });
  save.onclick = () => saveSlip({ ...slip, phpRate: round2(Number(rate.value) || 0), amount: round2(slip.hours * (Number(rate.value) || 0)) });
  const recalc = el('button', { textContent: 'Recount hours', hidden: !pending, title: 'Use the latest clock-in records, for example after fixing a shift' });
  recalc.onclick = async () => {
    const shifts = (await fetchShifts(slip.periodStart, slip.periodEnd)).filter((x) => x.email === slip.email);
    const { hours, amount: amt, days } = payFor(shifts, Number(rate.value) || 0);
    await saveSlip({ ...slip, hours, phpRate: round2(Number(rate.value) || 0), amount: amt, days });
  };
  const paid = el('button', { className: pending ? 'primary' : '', textContent: pending ? 'Mark paid' : 'Undo paid' });
  paid.onclick = () => {
    if (!pending && !confirm(`Mark ${slip.name}'s payslip as not paid?`)) return;
    saveSlip(pending ? { ...slip, status: 'paid', paidAt: Timestamp.now() } : { ...slip, status: 'pending', paidAt: null });
  };
  const remove = el('button', { className: 'danger', textContent: 'Delete', hidden: !pending });
  remove.onclick = async () => {
    if (!confirm(`Delete ${slip.name}'s pending payslip for ${fmtDay(slip.periodStart)} to ${fmtDay(slip.periodEnd)}?`)) return;
    try { await deleteDoc(doc(db, 'payslips', slipId(slip.periodStart, slip.email))); await loadPayroll(); } catch (err) { showError(err); }
  };
  const pdf = el('button', { textContent: 'Payslip PDF' });
  pdf.onclick = () => openDocument(payslipHtml({ ...slip, paidAt: asDate(slip.paidAt) }, bank));

  const status = el('span', { className: `pill ${slip.status}`, textContent: pending ? 'Pending' : `Paid ${fmtDay(dayKey(slip.paidAt.toDate(), BUSINESS_TZ))}` });
  const bankText = bank ? `${bank.bankName} · ${bank.accountName} · ${bank.accountNumber}` : 'No bank details yet';

  // Day-by-day hours, shown under the row on request.
  const daysRow = el('tr', { className: 'day-list', hidden: true }, el('td', { colSpan: 8 }, slip.days?.length
    ? el('ul', {}, ...slip.days.map((x) => el('li', { textContent: `${fmtWeekday(x.day)}: ${hmFromHours(x.hours)} (${x.hours.toFixed(2)} h)` })))
    : el('span', { className: 'muted', textContent: 'No daily breakdown saved for this payslip. Click "Recount hours" to add it.' })));
  const daily = el('button', { textContent: 'Daily hours' });
  daily.onclick = () => { daysRow.hidden = !daysRow.hidden; };

  const row = el('tr', {}, cell(slip.name), cell(slip.clientName || ''), numCell(slip.hours.toFixed(2)), cell(rate), amount,
    cell(status), cell(el('span', { className: bank ? '' : 'muted', textContent: bankText })), cell(daily, ' ', save, ' ', recalc, ' ', paid, ' ', pdf, ' ', remove));
  return [row, daysRow];
}

async function saveSlip(slip) {
  try {
    await setDoc(doc(db, 'payslips', slipId(slip.periodStart, slip.email)), { ...slip, ...stamp() });
    await loadPayroll();
  } catch (err) { showError(err); }
}

// Payroll only works in whole pay periods, picked from a list, so payslips can't overlap.
function fillPayPeriods() {
  const periods = payPeriods(payAnchor, calendarToday(BUSINESS_TZ));
  $('payPeriod').replaceChildren(...periods.map((p, i) => el('option', {
    value: `${p.start}|${p.end}`,
    textContent: `${fmtDay(p.start)} to ${fmtDay(p.end)}${i === 0 ? ' (still running)' : i === 1 ? ' (just ended)' : ''}`,
  })));
  $('payPeriod').selectedIndex = 1;
  choosePayPeriod();
}

function choosePayPeriod() {
  [$('payFrom').value, $('payTo').value] = $('payPeriod').value.split('|');
  loadPayroll().catch(showError);
}

$('payPeriod').onchange = choosePayPeriod;
$('payForm').onsubmit = (e) => e.preventDefault();

$('payCreateBtn').onclick = async () => {
  const from = $('payFrom').value; const to = $('payTo').value;
  if (to >= dayKey(new Date(), BUSINESS_TZ)
    && !confirm('This pay period has not ended yet, so later shifts would be missing. Create payslips anyway? (You can use "Recount hours" later.)')) return;
  try {
    const shifts = await fetchShifts(from, to);
    // One payslip per VA per period: skip anyone who already has a payslip covering any of these days.
    const all = (await getDocs(collection(db, 'payslips'))).docs.map((d) => d.data());
    const period = { start: from, end: to };
    const have = new Set(all.filter((x) => x.periodStart === from).map((x) => x.email));
    const overlapping = new Set(all.filter((x) => x.periodStart !== from && periodsOverlap(period, { start: x.periodStart, end: x.periodEnd })).map((x) => x.email));
    const byEmail = new Map();
    for (const s of shifts) byEmail.set(s.email, [...(byEmail.get(s.email) ?? []), s]);
    const openCount = shifts.filter((s) => !s.clockOut).length;
    const b = writeBatch(db);
    let made = 0;
    for (const [email, theirs] of byEmail) {
      const va = vas.get(email);
      if (!va || have.has(email) || overlapping.has(email)) continue;
      const { hours, amount, days } = payFor(theirs, va.phpRate || 0);
      if (hours === 0) continue;
      b.set(doc(db, 'payslips', slipId(from, email)), {
        email, name: va.name, clientName: va.clientName || '', position: va.position || '',
        periodStart: from, periodEnd: to, hours, phpRate: va.phpRate || 0, amount, days, status: 'pending', ...stamp(),
      });
      made += 1;
    }
    if (made) await b.commit();
    await loadPayroll();
    const skipped = [...overlapping].map((e) => vas.get(e)?.name ?? e);
    alert(`${made} payslip${made === 1 ? '' : 's'} created.`
      + (skipped.length ? ` Skipped ${skipped.join(', ')}: they already have a payslip covering some of these days.` : '')
      + (openCount ? ` ${openCount} shift(s) in this period are still open and were not counted; close them, then use "Recount hours".` : ''));
  } catch (err) { showError(err); }
};

// ---------- Client invoices ----------

let company = {};
let payAnchor = DEFAULT_PAY_ANCHOR;

async function loadCompany() {
  const [snap, cycle] = await Promise.all([
    getDoc(doc(db, 'settings', 'company')).catch(showError),
    getDoc(doc(db, 'settings', 'payCycle')).catch(showError),
  ]);
  company = snap?.exists() ? snap.data() : {};
  payAnchor = (cycle?.exists() && cycle.data().anchor) || company.payAnchor || DEFAULT_PAY_ANCHOR;
  $('coBank').value = company.bankName ?? '';
  $('coAccountName').value = company.accountName ?? '';
  $('coAccountNumber').value = company.accountNumber ?? '';
  $('coPayAnchor').value = payAnchor;
}

// Saved where VAs can read it too, so their "This pay period" box uses the same dates.
$('payCycleForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await setDoc(doc(db, 'settings', 'payCycle'), { anchor: $('coPayAnchor').value });
    payAnchor = $('coPayAnchor').value;
    fillPayPeriods();
    $('payCycleNote').textContent = 'Saved. Pay periods now start from this date.';
  } catch (err) { showError(err); }
};

// ---------- Signature ----------

let signatureUrl = null;
const MAX_SIGNATURE_CHARS = 290_000; // the database rule allows 300,000

async function loadSignature() {
  const snap = await getDoc(doc(db, 'settings', 'signature')).catch(showError);
  signatureUrl = snap?.exists() ? snap.data().dataUrl : null;
  $('sigPreview').src = signatureUrl ?? '';
  show('sigPreview', !!signatureUrl);
  show('sigNone', !signatureUrl);
}

// Shrinks an uploaded image to at most 600px wide so it fits in the database.
function imageToDataUrl(file) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(1, 600 / img.width);
      const canvas = el('canvas', { width: Math.round(img.width * scale), height: Math.round(img.height * scale) });
      const ctx = canvas.getContext('2d');
      ctx.fillStyle = '#fff';
      ctx.fillRect(0, 0, canvas.width, canvas.height);
      ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
      URL.revokeObjectURL(img.src);
      const png = canvas.toDataURL('image/png');
      resolve(png.length <= MAX_SIGNATURE_CHARS ? png : canvas.toDataURL('image/jpeg', 0.85));
    };
    img.onerror = () => reject(new Error('That file could not be read as an image.'));
    img.src = URL.createObjectURL(file);
  });
}

$('sigFile').onchange = async () => {
  const file = $('sigFile').files[0];
  if (!file) return;
  try {
    const dataUrl = await imageToDataUrl(file);
    if (dataUrl.length > MAX_SIGNATURE_CHARS) { alert('That image is too detailed. Crop it closer to the signature and try again.'); return; }
    await setDoc(doc(db, 'settings', 'signature'), { dataUrl });
    $('sigNote').textContent = 'Saved.';
    await loadSignature();
  } catch (err) { showError(err); }
};

// ---------- COE requests ----------

function renderCoeRequests(snap) {
  const requests = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }))
    // Waiting requests first, then newest first.
    .sort((a, b) => (b.status === 'pending') - (a.status === 'pending') || b.requestedAt.toMillis() - a.requestedAt.toMillis());
  const waiting = requests.filter((r) => r.status === 'pending').length;
  $('coeCount').textContent = String(waiting);
  show('coeCount', waiting > 0);
  show('coeEmpty', requests.length === 0);
  $('coeRows').replaceChildren(...requests.map((r) => {
    const who = el('div', {}, el('div', { textContent: r.name }), el('div', { className: 'muted', textContent: r.email }));
    const label = { pending: 'Waiting', approved: `Approved ${r.issuedOn ? fmtDay(r.issuedOn) : ''}`, denied: 'Denied' }[r.status];
    const status = el('span', { className: `pill ${r.status === 'approved' ? 'paid' : 'pending'}`, textContent: label });
    const actions = [];
    if (r.status === 'pending') {
      const approve = el('button', { className: 'primary', textContent: 'Approve' });
      approve.onclick = () => approveCoe(r, approve);
      const deny = el('button', { textContent: 'Deny' });
      deny.onclick = () => {
        if (!confirm(`Deny ${r.name}'s certificate request?`)) return;
        updateDoc(doc(db, 'coeRequests', r.id), { status: 'denied', decidedBy: me.email, decidedAt: serverTimestamp() }).catch(showError);
      };
      actions.push(approve, ' ', deny);
    } else if (r.status === 'approved') {
      const view = el('button', { textContent: 'View' });
      view.onclick = () => openDocument(coeHtml({
        name: r.fullName, position: r.position, startDate: r.startDate, purpose: r.purpose, issuedOn: r.issuedOn, signatureUrl: r.signature,
      }));
      actions.push(view);
    }
    return el('tr', {}, cell(who), cell(r.purpose), cell(fmt(r.requestedAt.toDate())), cell(status), cell(...actions));
  }));
}

// Approving freezes the certificate's details and the signature into the request, so it reads the same forever.
async function approveCoe(r, button) {
  if (!signatureUrl) { alert('Upload the signature under Company details first.'); return; }
  const va = vas.get(r.email) ?? {};
  try {
    const profile = await getDoc(doc(db, 'profiles', r.email));
    const fullName = (profile.exists() && profile.data().fullName) || va.name || r.name;
    const summary = `Approve and sign this certificate?\n\nName: ${fullName}\nPosition: ${va.position || '(not set)'}\n`
      + `Start date: ${va.startDate ? fmtDay(va.startDate) : '(not set)'}\nReason: ${r.purpose}\n\nFix any missing details under VAs > Edit first.`;
    if (!confirm(summary)) return;
    button.disabled = true;
    await updateDoc(doc(db, 'coeRequests', r.id), {
      status: 'approved', decidedBy: me.email, decidedAt: serverTimestamp(),
      fullName, position: va.position || '', startDate: va.startDate || '', issuedOn: dayKey(new Date(), BUSINESS_TZ), signature: signatureUrl,
    });
  } catch (err) { showError(err); button.disabled = false; }
}

$('companyForm').onsubmit = async (e) => {
  e.preventDefault();
  const next = { ...company, bankName: $('coBank').value.trim(), accountName: $('coAccountName').value.trim(), accountNumber: $('coAccountNumber').value.trim() };
  try {
    await setDoc(doc(db, 'settings', 'company'), next);
    company = next;
    $('companyNote').textContent = 'Saved.';
  } catch (err) { showError(err); }
};

$('invForm').onsubmit = async (e) => {
  e.preventDefault();
  const client = $('invClient').value;
  if (!client) { alert('Assign a client to a VA first (VAs > Edit).'); return; }
  try {
    const shifts = (await fetchShifts($('invFrom').value, $('invTo').value)).filter((s) => s.client === client);
    const lines = invoiceLines(shifts).map((l) => {
      const va = vas.get(l.email) ?? {};
      return { ...l, name: va.name ?? l.email, position: va.position ?? '', usdRate: va.usdRate ?? 0 };
    });
    openDocument(invoiceHtml({
      clientName: client, invoiceDate: calendarToday(BUSINESS_TZ), dueDate: new Date(`${$('invDue').value}T00:00`), lines, company, signatureUrl,
    }));
  } catch (err) { showError(err); }
};
