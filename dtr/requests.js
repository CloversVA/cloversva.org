// Leave/absence requests and overtime requests: VAs file them, admins approve or deny.
import {
  collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import {
  BUSINESS_TZ, LEAVE_NOTICE_DAYS, MAX_SHIFT_HOURS, addDays, dayKey, formatHM, leaveNoticeOk,
} from './report.js?v=9';
import { $, cell, el, fmt, fmtDay, numCell, show, showError } from './ui.js?v=9';

const TYPE_LABEL = { leave: 'Leave (unpaid)', absence: 'Absence (unpaid)' };
const datesText = (r) => (r.startDay === r.endDay ? fmtDay(r.startDay) : `${fmtDay(r.startDay)} to ${fmtDay(r.endDay)}`);
const pill = (status) => el('span', {
  className: `pill ${status === 'approved' ? 'paid' : 'pending'}`,
  textContent: { pending: 'Waiting', approved: 'Approved', denied: 'Denied' }[status],
});
const newestFirst = (field) => (a, b) => (b.status === 'pending') - (a.status === 'pending') || b[field].toMillis() - a[field].toMillis();

// ---------- VA ----------

let me = null;
// Approved overtime for my shifts, by shift id, so pay estimates match payroll.
export const myOvertime = new Map();

export function startVaRequests(signedIn, track, onOvertimeChange) {
  me = signedIn;
  track(onSnapshot(query(collection(db, 'leaveRequests'), where('email', '==', me.email)), (snap) => {
    const rows = snap.docs.map((d) => d.data({ serverTimestamps: 'estimate' })).sort(newestFirst('requestedAt'));
    show('myLeaveEmpty', rows.length === 0);
    $('myLeaveRows').replaceChildren(...rows.map((r) =>
      el('tr', {}, cell(datesText(r)), cell(TYPE_LABEL[r.type]), cell(r.reason), cell(pill(r.status)))));
  }, showError));

  track(onSnapshot(query(collection(db, 'overtime'), where('email', '==', me.email)), (snap) => {
    myOvertime.clear();
    for (const d of snap.docs) myOvertime.set(d.id, d.data());
    onOvertimeChange();
  }, showError));
}

$('leaveForm').onsubmit = async (e) => {
  e.preventDefault();
  const type = document.querySelector('input[name="leaveType"]:checked').value;
  const startDay = $('leaveStart').value;
  const endDay = $('leaveEnd').value;
  const today = dayKey(new Date(), BUSINESS_TZ);
  if (endDay < startDay) { $('leaveNote').textContent = 'The last day must be on or after the first day.'; return; }
  if (type === 'leave' && !leaveNoticeOk(startDay, today)) {
    $('leaveNote').textContent = `Leave must be filed at least ${LEAVE_NOTICE_DAYS} days ahead (first day ${fmtDay(addDays(today, LEAVE_NOTICE_DAYS))} or later). For a sudden day off, file an absence.`;
    return;
  }
  try {
    await setDoc(doc(collection(db, 'leaveRequests')), {
      email: me.email, name: me.name, type, startDay, endDay, reason: $('leaveReason').value.trim(), status: 'pending', requestedAt: serverTimestamp(),
    });
    e.target.reset();
    $('leaveNote').textContent = 'Request sent.';
  } catch (err) { showError(err); }
};

// The overtime button on a shift row longer than 8 hours: worked = the shift's length in ms.
export function overtimeCell(entryId, workedMs) {
  const over = workedMs - MAX_SHIFT_HOURS * 3_600_000;
  if (over <= 0) return cell();
  const r = myOvertime.get(entryId);
  if (r) return cell(pill(r.status), r.status === 'approved' ? ` +${r.extraHours} h` : '');
  const btn = el('button', { textContent: 'Request overtime' });
  btn.onclick = () => openOvertime(entryId, workedMs);
  return cell(btn);
}

let otEntry = null;
function openOvertime(entryId, workedMs) {
  otEntry = entryId;
  $('otShift').textContent = `You worked ${formatHM(workedMs)} on this shift. Without approval it is paid as 8:00.`;
  $('otHours').value = Math.ceil(((workedMs / 3_600_000) - MAX_SHIFT_HOURS) * 4) / 4; // rounded up to 15 minutes
  $('otReason').value = '';
  $('otDialog').showModal();
}
$('otCancel').onclick = () => $('otDialog').close();
$('otForm').onsubmit = async (e) => {
  e.preventDefault();
  try {
    await setDoc(doc(db, 'overtime', otEntry), {
      email: me.email, name: me.name, extraHours: Number($('otHours').value), reason: $('otReason').value.trim(),
      status: 'pending', requestedAt: serverTimestamp(),
    });
    $('otDialog').close();
  } catch (err) { showError(err); }
};

// ---------- Admin ----------

const decide = (path, id, status, by) => updateDoc(doc(db, path, id), { status, decidedBy: by, decidedAt: serverTimestamp() }).catch(showError);

export function startAdminRequests(admin, track, shiftLookup) {
  track(onSnapshot(collection(db, 'leaveRequests'), (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort(newestFirst('requestedAt'));
    const waiting = rows.filter((r) => r.status === 'pending').length;
    $('leaveCount').textContent = String(waiting);
    show('leaveCount', waiting > 0);
    show('leaveEmpty', rows.length === 0);
    $('leaveRows').replaceChildren(...rows.map((r) => {
      const actions = r.status !== 'pending' ? [] : [
        el('button', { className: 'primary', textContent: 'Approve', onclick: () => decide('leaveRequests', r.id, 'approved', admin.email) }),
        ' ',
        el('button', { textContent: 'Deny', onclick: () => confirm(`Deny ${r.name}'s request?`) && decide('leaveRequests', r.id, 'denied', admin.email) }),
      ];
      return el('tr', {}, cell(r.name), cell(datesText(r)), cell(TYPE_LABEL[r.type]), cell(r.reason),
        cell(fmt(r.requestedAt.toDate())), cell(pill(r.status)), cell(...actions));
    }));
  }, showError));

  track(onSnapshot(collection(db, 'overtime'), async (snap) => {
    const rows = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort(newestFirst('requestedAt'));
    const waiting = rows.filter((r) => r.status === 'pending').length;
    $('otCount').textContent = String(waiting);
    show('otCount', waiting > 0);
    show('otEmpty', rows.length === 0);
    const shifts = await shiftLookup(rows.map((r) => r.id));
    $('otRows').replaceChildren(...rows.map((r) => {
      const s = shifts.get(r.id);
      const actions = r.status !== 'pending' ? [] : [
        el('button', { className: 'primary', textContent: 'Approve', onclick: () => decide('overtime', r.id, 'approved', admin.email) }),
        ' ',
        el('button', { textContent: 'Deny', onclick: () => confirm(`Deny ${r.name}'s overtime?`) && decide('overtime', r.id, 'denied', admin.email) }),
      ];
      return el('tr', {}, cell(r.name), cell(s ? fmt(s.clockIn) : '(shift deleted)'), numCell(s?.clockOut ? formatHM(s.clockOut - s.clockIn) : ''),
        numCell(`${r.extraHours} h`), cell(r.reason), cell(pill(r.status)), cell(...actions));
    }));
  }, showError));
}
