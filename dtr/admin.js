import {
  Timestamp, collection, deleteDoc, doc, getDoc, getDocs, onSnapshot, orderBy, query, serverTimestamp, setDoc, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { invoiceHtml, payslipHtml, timesheetHtml } from './docs.js?v=2';
import { db } from './firebase.js?v=2';
import {
  formatDuration, formatPhp, invoiceLines, payFor, periodRange, round2, summarize, toCsv, totalsToCsv,
} from './report.js?v=2';
import {
  $, asDate, cell, downloadText, el, fmt, fmtDay, numCell, openDocument, show, showError, toDateInput, toDateTimeInput,
} from './ui.js?v=2';

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
    const clients = [...new Set([...vas.values()].map((v) => v.clientName).filter(Boolean))].sort();
    $('clientList').replaceChildren(...clients.map((c) => el('option', { value: c })));
    const current = $('invClient').value;
    $('invClient').replaceChildren(...clients.map((c) => el('option', { value: c, textContent: c })));
    if (clients.includes(current)) $('invClient').value = current;
  }, showError));

  setPeriod('ts', 'thisHalf');
  setPeriod('pay', 'lastHalf');
  setPeriod('inv', 'lastHalf');
  const due = new Date(); due.setDate(due.getDate() + 7);
  $('invDue').value = toDateInput(due);
  loadCompany();
}

// ---------- Periods ----------

function setPeriod(prefix, kind) {
  const [from, to] = periodRange(kind);
  $(`${prefix}From`).value = toDateInput(from);
  $(`${prefix}To`).value = toDateInput(to);
}

const AFTER_PERIOD = { ts: () => runTimesheet(), pay: () => loadPayroll(), inv: () => {} };
for (const btn of document.querySelectorAll('[data-period]')) {
  btn.onclick = () => {
    setPeriod(btn.dataset.for, btn.dataset.period);
    Promise.resolve(AFTER_PERIOD[btn.dataset.for]()).catch(showError);
  };
}

// Shifts that started between two YYYY-MM-DD days, inclusive.
async function fetchShifts(fromDay, toDay) {
  const from = new Date(`${fromDay}T00:00`);
  const to = new Date(`${toDay}T00:00`); to.setDate(to.getDate() + 1);
  const snap = await getDocs(query(collection(db, 'entries'),
    where('clockIn', '>=', Timestamp.fromDate(from)), where('clockIn', '<', Timestamp.fromDate(to)), orderBy('clockIn')));
  return snap.docs.map((d) => {
    const s = d.data();
    return {
      id: d.id, email: s.email, name: s.name, client: s.client || vas.get(s.email)?.clientName || '',
      clockIn: asDate(s.clockIn), clockOut: asDate(s.clockOut), edited: !!s.lastEditId,
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
      numCell(va.phpRate ? formatPhp(va.phpRate) : ''), numCell(va.usdRate ? `$${va.usdRate.toFixed(2)}` : ''),
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
  $('vaDialog').showModal();
  getDoc(doc(db, 'profiles', va.email)).then((snap) => {
    const p = snap.exists() ? snap.data() : null;
    if (!p) { $('vaProfile').replaceChildren(el('dd', { className: 'muted', textContent: 'Not filled in yet.' })); return; }
    const rows = [['Full name', p.fullName], ['Date of birth', p.birthDate ? fmtDay(p.birthDate) : ''], ['Address', p.address], ['Phone', p.phone]];
    $('vaProfile').replaceChildren(...rows.flatMap(([k, v]) => [el('dt', { textContent: k }), el('dd', { textContent: v || '-' })]));
  }).catch(showError);
}

$('vaCancel').onclick = () => $('vaDialog').close();

$('vaForm').onsubmit = async (e) => {
  e.preventDefault();
  const record = {
    name: $('vaName').value.trim(),
    role: $('vaRole').value,
    active: editingVa.active,
    clientName: $('vaClient').value.trim(),
    position: $('vaPosition').value.trim(),
    phpRate: round2(Number($('vaPhp').value) || 0),
    usdRate: round2(Number($('vaUsd').value) || 0),
    startDate: $('vaStart').value,
  };
  try {
    await setDoc(doc(db, 'allowed', editingVa.email), record);
    $('vaDialog').close();
  } catch (err) { showError(err); }
};

// ---------- Timesheets ----------

let tsShifts = [];

async function runTimesheet() {
  tsShifts = await fetchShifts($('tsFrom').value, $('tsTo').value);
  const totals = summarize(tsShifts).map((r) => ({ ...r, clientName: vas.get(r.email)?.clientName || '' }));
  $('totalRows').replaceChildren(...totals.map((r) =>
    el('tr', {}, cell(r.name), cell(r.clientName), numCell(String(r.shifts)), numCell(r.hours.toFixed(2)), numCell(r.open ? String(r.open) : ''))));
  $('shiftRows').replaceChildren(...tsShifts.map((s) => {
    const edit = el('button', { textContent: s.clockOut ? 'Fix' : 'Close shift' });
    edit.onclick = () => openShiftEditor(s);
    return el('tr', {}, cell(s.name), cell(fmt(s.clockIn)),
      cell(s.clockOut ? fmt(s.clockOut) : 'Open'), cell(s.clockOut ? formatDuration(s.clockOut - s.clockIn) : ''),
      cell(edit, s.edited ? el('span', { className: 'muted', textContent: ' edited' }) : null));
  }));
  $('csvBtn').disabled = $('tsPrintBtn').disabled = tsShifts.length === 0;
}

$('tsForm').onsubmit = (e) => { e.preventDefault(); runTimesheet().catch(showError); };

$('csvBtn').onclick = () => {
  const csv = `${totalsToCsv(summarize(tsShifts))}\r\n\r\n${toCsv(tsShifts, (d) => toDateTimeInput(d).replace('T', ' '))}`;
  downloadText(`cloversva-hours_${$('tsFrom').value}_to_${$('tsTo').value}.csv`, csv);
};

$('tsPrintBtn').onclick = () => {
  const totals = summarize(tsShifts).map((r) => ({ ...r, clientName: vas.get(r.email)?.clientName || '' }));
  openDocument(timesheetHtml({ from: $('tsFrom').value, to: $('tsTo').value, totals, shifts: tsShifts }));
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
  const clockIn = new Date($('editIn').value);
  const clockOut = new Date($('editOut').value);
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
  $('payRows').replaceChildren(...slips.map((s) => payrollRow(s, banks.get(s.email))));
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
    const { hours, amount: amt } = payFor(shifts, Number(rate.value) || 0);
    await saveSlip({ ...slip, hours, phpRate: round2(Number(rate.value) || 0), amount: amt });
  };
  const paid = el('button', { className: pending ? 'primary' : '', textContent: pending ? 'Mark paid' : 'Undo paid' });
  paid.onclick = () => {
    if (!pending && !confirm(`Mark ${slip.name}'s payslip as not paid?`)) return;
    saveSlip(pending ? { ...slip, status: 'paid', paidAt: Timestamp.now() } : { ...slip, status: 'pending', paidAt: null });
  };
  const pdf = el('button', { textContent: 'Payslip PDF' });
  pdf.onclick = () => openDocument(payslipHtml({ ...slip, paidAt: asDate(slip.paidAt) }, bank));

  const status = el('span', { className: `pill ${slip.status}`, textContent: pending ? 'Pending' : `Paid ${fmtDay(toDateInput(slip.paidAt.toDate()))}` });
  const bankText = bank ? `${bank.bankName} · ${bank.accountName} · ${bank.accountNumber}` : 'No bank details yet';
  return el('tr', {}, cell(slip.name), cell(slip.clientName || ''), numCell(slip.hours.toFixed(2)), cell(rate), amount,
    cell(status), cell(el('span', { className: bank ? '' : 'muted', textContent: bankText })), cell(save, ' ', recalc, ' ', paid, ' ', pdf));
}

async function saveSlip(slip) {
  try {
    await setDoc(doc(db, 'payslips', slipId(slip.periodStart, slip.email)), { ...slip, ...stamp() });
    await loadPayroll();
  } catch (err) { showError(err); }
}

$('payForm').onsubmit = (e) => { e.preventDefault(); loadPayroll().catch(showError); };

$('payCreateBtn').onclick = async () => {
  const from = $('payFrom').value; const to = $('payTo').value;
  try {
    const shifts = await fetchShifts(from, to);
    const existing = await getDocs(query(collection(db, 'payslips'), where('periodStart', '==', from)));
    const have = new Set(existing.docs.map((d) => d.data().email));
    const byEmail = new Map();
    for (const s of shifts) byEmail.set(s.email, [...(byEmail.get(s.email) ?? []), s]);
    const openCount = shifts.filter((s) => !s.clockOut).length;
    const b = writeBatch(db);
    let made = 0;
    for (const [email, theirs] of byEmail) {
      const va = vas.get(email);
      if (!va || have.has(email)) continue;
      const { hours, amount } = payFor(theirs, va.phpRate || 0);
      if (hours === 0) continue;
      b.set(doc(db, 'payslips', slipId(from, email)), {
        email, name: va.name, clientName: va.clientName || '', position: va.position || '',
        periodStart: from, periodEnd: to, hours, phpRate: va.phpRate || 0, amount, status: 'pending', ...stamp(),
      });
      made += 1;
    }
    if (made) await b.commit();
    await loadPayroll();
    alert(`${made} payslip${made === 1 ? '' : 's'} created.${openCount ? ` ${openCount} shift(s) in this period are still open and were not counted; close them, then use "Recount hours".` : ''}`);
  } catch (err) { showError(err); }
};

// ---------- Client invoices ----------

let company = {};

async function loadCompany() {
  const snap = await getDoc(doc(db, 'settings', 'company')).catch(showError);
  company = snap?.exists() ? snap.data() : {};
  $('coBank').value = company.bankName ?? '';
  $('coAccountName').value = company.accountName ?? '';
  $('coAccountNumber').value = company.accountNumber ?? '';
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
    openDocument(invoiceHtml({ clientName: client, invoiceDate: new Date(), dueDate: new Date(`${$('invDue').value}T00:00`), lines, company }));
  } catch (err) { showError(err); }
};
