// Past invoices and payroll files, stored in the database (about 700 KB per file on the free plan).
import {
  collection, deleteDoc, doc, getDoc, onSnapshot, query, serverTimestamp, where, writeBatch,
} from 'https://www.gstatic.com/firebasejs/13.0.0/firebase-firestore.js';
import { db } from './firebase.js?v=2';
import { $, cell, downloadBlob, el, fmt, show, showError } from './ui.js?v=10';

const MAX_DATA_URL = 990_000; // the database rule allows 1,000,000 characters (a ~740 KB file)
const KIND = { payroll: 'Payroll', invoice: 'Client invoice', other: 'Other' };

async function download(f) {
  try {
    const snap = await getDoc(doc(db, 'fileData', f.id));
    if (!snap.exists()) { alert('That file is missing.'); return; }
    downloadBlob(f.fileName, await (await fetch(snap.data().dataUrl)).blob());
  } catch (err) { showError(err); }
}

const byNewest = (a, b) => b.at.toMillis() - a.at.toMillis();
const filesFrom = (snap) => snap.docs.map((d) => ({ id: d.id, ...d.data({ serverTimestamps: 'estimate' }) }));

// VAs see files shared with them and with all VAs.
export function startVaFiles(me, track) {
  track(onSnapshot(query(collection(db, 'files'), where('visibleTo', 'in', [me.email, 'all'])), (snap) => {
    const files = filesFrom(snap).sort(byNewest);
    show('myFilesEmpty', files.length === 0);
    $('myFileRows').replaceChildren(...files.map((f) => {
      const btn = el('button', { textContent: 'Download' });
      btn.onclick = () => download(f);
      return el('tr', {}, cell(f.title), cell(KIND[f.kind]), cell(fmt(f.at.toDate())), cell(btn));
    }));
  }, showError));
}

// ---------- Admin ----------

let me = null;
let vaNames = new Map();
const visibleLabel = (v) => (v === 'admins' ? 'Admins only' : v === 'all' ? 'All VAs' : vaNames.get(v) ?? v);

export function startAdminFiles(signedIn, track) {
  me = signedIn;
  track(onSnapshot(collection(db, 'files'), (snap) => {
    const files = filesFrom(snap).sort(byNewest);
    show('filesEmpty', files.length === 0);
    $('fileRows').replaceChildren(...files.map((f) => {
      const get = el('button', { textContent: 'Download' });
      get.onclick = () => download(f);
      const remove = el('button', { className: 'danger', textContent: 'Delete' });
      remove.onclick = async () => {
        if (!confirm(`Delete "${f.title}"? Nobody will be able to download it anymore.`)) return;
        const b = writeBatch(db);
        b.delete(doc(db, 'files', f.id));
        b.delete(doc(db, 'fileData', f.id));
        await b.commit().catch(showError);
      };
      return el('tr', {}, cell(f.title), cell(KIND[f.kind]), cell(visibleLabel(f.visibleTo)), cell(fmt(f.at.toDate())), cell(get, ' ', remove));
    }));
  }, showError));
}

// Called by the admin screen whenever the VA list changes.
export function setFileAudience(vas) {
  vaNames = new Map(vas.map((v) => [v.email, v.name]));
  const current = $('fileVisible').value;
  $('fileVisible').replaceChildren(
    el('option', { value: 'admins', textContent: 'Admins only' }),
    el('option', { value: 'all', textContent: 'All VAs' }),
    ...vas.filter((v) => v.active).sort((a, b) => a.name.localeCompare(b.name)).map((v) => el('option', { value: v.email, textContent: `Only ${v.name}` })),
  );
  if (current) $('fileVisible').value = current;
}

const readAsDataUrl = (file) => new Promise((resolve, reject) => {
  const r = new FileReader();
  r.onload = () => resolve(r.result);
  r.onerror = () => reject(new Error('That file could not be read.'));
  r.readAsDataURL(file);
});

$('fileForm').onsubmit = async (e) => {
  e.preventDefault();
  const file = $('fileInput').files[0];
  if (!file) return;
  try {
    const dataUrl = await readAsDataUrl(file);
    if (dataUrl.length > MAX_DATA_URL) {
      alert(`That file is ${Math.round(file.size / 1024)} KB. The limit is about 700 KB; compress the PDF or split it and try again.`);
      return;
    }
    const ref = doc(collection(db, 'files'));
    const b = writeBatch(db);
    b.set(doc(db, 'fileData', ref.id), { dataUrl });
    b.set(ref, {
      title: $('fileTitle').value.trim(), kind: $('fileKind').value, visibleTo: $('fileVisible').value,
      fileName: file.name.slice(0, 200), size: file.size, by: me.email, at: serverTimestamp(),
    });
    $('fileNote').textContent = 'Uploading...';
    await b.commit();
    e.target.reset();
    $('fileNote').textContent = 'Uploaded.';
  } catch (err) { $('fileNote').textContent = ''; showError(err); }
};
