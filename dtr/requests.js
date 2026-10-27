// Leave/absence requests and overtime requests: VAs file them, admins approve or deny.
// Leave goes to the VA's client first: the admin sends the client a letter, records the client's answer,
// and can only approve once the client has approved.
import {
  collection, doc, onSnapshot, query, serverTimestamp, setDoc, updateDoc, where,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { leaveLetterHtml } from './docs.js?v=10';
import { db } from './firebase.js?v=2';
import {
  BUSINESS_TZ, LEAVE_NOTICE_DAYS, MAX_SHIFT_HOURS, addDays, dayKey, formatHM, leaveNoticeOk,
} from './report.js?v=10';
import { $, cell, el, fmt, fmtDay, numCell, openDocument, show, showError } from './ui.js?v=10';

const TYPE_LABEL = { leave: 'Leave (unpaid)', absence: 'Absence (unpaid)' };
const datesText = (r) => (r.startDay === r.endDay ? fmtDay(r.startDay) : `${fmtDay(r.startDay)} to ${fmtDay(r.endDay)}`);
const pill = (status) => el('span', {
  className: `pill ${status === 'approved' ? 'paid' : 'pending'}`,
  textContent: { pending: 'Waiting', approved: 'Approved', denied: 'Denied' }[status],
});
// Where a waiting leave request is with the client, for the status pill.
const CLIENT_LABEL = { sent: 'With client', approved: 'Client approved', declined: 'Client declined' };
const leavePill = (r) => (r.status === 'pending' ? el('span', {
  className: `pill ${r.clientStatus === 'approved' ? 'paid' : 'pending'}`,
  textContent: r.clientStatus ? CLIENT_LABEL[r.clientStatus] : 'Waiting',
}) : pill(r.status));
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
      el('tr', {}, cell(datesText(r)), cell(TYPE_LABEL[r.type]), cell(r.reason), cell(leavePill(r)))));
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

// Opens the letter (sender: the admin; requester: the VA; recipient: the VA's client) and marks it sent.
async function sendLetter(r, admin, vaLookup, vaFullName) {
  const va = vaLookup(r.email) ?? {};
  if (!va.clientName) { alert(`Assign a client to ${r.name} first (VAs > Edit).`); return; }
  const tab = window.open('', '_blank');
  try {
    openDocument(leaveLetterHtml({
      request: { ...r, requestedAt: r.requestedAt.toDate(), typeLabel: TYPE_LABEL[r.type] },
      va: { fullName: await vaFullName(r.email), position: va.position, clientName: va.clientName },
      sender: { name: admin.name, email: admin.email },
    }), tab);
    if (r.status === 'pending' && !r.clientStatus) {
      await updateDoc(doc(db, 'leaveRequests', r.id), { clientStatus: 'sent', clientName: va.clientName, sentBy: admin.email, sentAt: serverTimestamp() });
    }
  } catch (err) { tab?.close(); showError(err); }
}

// The client's answer; a declined request is closed as denied straight away.
function clientDecision(r, answer, admin) {
  const update = { clientStatus: answer, clientDecidedBy: admin.email, clientDecidedAt: serverTimestamp() };
  if (answer === 'declined') Object.assign(update, { status: 'denied', decidedBy: admin.email, decidedAt: serverTimestamp() });
  return updateDoc(doc(db, 'leaveRequests', r.id), update).catch(showError);
}

const decide = (path, id, status, by) => updateDoc(doc(db, path, id), { status, decidedBy: by, decidedAt: serverTimestamp() }).catch(showError);

let redrawLeave = () => {};
// Called when VA records change, so the Client column stays current.
export const refreshLeave = () => redrawLeave();

// vaLookup(email) gives the VA's allowed record; vaFullName(email) resolves to the name on their profile.
export function startAdminRequests(admin, track, shiftLookup, vaLookup, vaFullName) {
  track(onSnapshot(collection(db, 'leaveRequests'), (snap) => {
    redrawLeave = () => renderLeave(snap, admin, vaLookup, vaFullName);
    redrawLeave();
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

function renderLeave(snap, admin, vaLookup, vaFullName) {
  const rows = snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) })).sort(newestFirst('requestedAt'));
  const waiting = rows.filter((r) => r.status === 'pending').length;
  $('leaveCount').textContent = String(waiting);
  show('leaveCount', waiting > 0);
  show('leaveEmpty', rows.length === 0);
  $('leaveRows').replaceChildren(...rows.map((r) => {
    const client = vaLookup(r.email)?.clientName || '';
    const letter = el('button', { textContent: 'Letter for client', onclick: () => sendLetter(r, admin, vaLookup, vaFullName) });
    const actions = r.status !== 'pending' ? [letter] : [letter, ' '];
    if (r.status === 'pending' && r.clientStatus !== 'approved') {
      actions.push(
        el('button', { textContent: 'Client approved', onclick: () => clientDecision(r, 'approved', admin) }), ' ',
        el('button', { textContent: 'Client declined', onclick: () => confirm(`Record that the client declined ${r.name}'s request? It will be denied.`) && clientDecision(r, 'declined', admin) }), ' ',
      );
    }
    if (r.status === 'pending') {
      actions.push(
        el('button', {
          className: 'primary', textContent: 'Approve', disabled: r.clientStatus !== 'approved',
          title: r.clientStatus === 'approved' ? '' : 'The client must approve first',
          onclick: () => decide('leaveRequests', r.id, 'approved', admin.email),
        }), ' ',
        el('button', { textContent: 'Deny', onclick: () => confirm(`Deny ${r.name}'s request?`) && decide('leaveRequests', r.id, 'denied', admin.email) }),
      );
    }
    return el('tr', {}, cell(r.name), cell(datesText(r)), cell(TYPE_LABEL[r.type]), cell(r.reason),
      cell(fmt(r.requestedAt.toDate())), cell(client || '(no client)'), cell(leavePill(r)), cell(...actions));
  }));

}
