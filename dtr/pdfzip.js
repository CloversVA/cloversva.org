// "Download all": turns printable documents (from docs.js) into PDF files and saves them together in one .zip.
// Each document is drawn in a hidden frame, captured as an image (html2canvas) and placed on A4 pages (jsPDF).
// The three tools are only fetched the first time someone uses it.
const LIBS = {
  html2canvas: 'https://cdnjs.cloudflare.com/ajax/libs/html2canvas/1.4.1/html2canvas.min.js',
  jspdf: 'https://cdnjs.cloudflare.com/ajax/libs/jspdf/2.5.1/jspdf.umd.min.js',
  jszip: 'https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js',
};

const loadScript = (src) => new Promise((resolve, reject) => {
  const s = document.createElement('script');
  s.src = src;
  s.onload = resolve;
  s.onerror = reject;
  document.head.append(s);
});

let loading = null;
function loadLibs() {
  loading ??= Promise.all(Object.values(LIBS).map(loadScript))
    .then(() => ({ html2canvas: window.html2canvas, jsPDF: window.jspdf.jsPDF, JSZip: window.JSZip }))
    .catch(() => { loading = null; throw new Error('Could not load the PDF tools. Check your connection and try again.'); });
  return loading;
}

// Lower = smaller files. 0.8 keeps text sharp at the 2x capture size.
const JPEG_QUALITY = 0.8;

// A4 in millimetres, with a 10 mm margin.
const PAGE = { w: 210, h: 297, margin: 10 };

async function htmlToPdf(html, { html2canvas, jsPDF }) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-10000px;top:0;width:850px;height:1200px;border:0;';
  frame.setAttribute('aria-hidden', 'true');
  document.body.append(frame);
  try {
    // Without the print button and the automatic print dialog.
    const clean = html.replace(/<script>[\s\S]*?<\/script>/g, '').replace(/<div class="toolbar">[\s\S]*?<\/div>/, '');
    await new Promise((resolve) => { frame.onload = resolve; frame.srcdoc = clean; });
    const doc = frame.contentDocument;
    await Promise.all([...doc.images].map((img) => (img.complete ? null : new Promise((r) => { img.onload = r; img.onerror = r; }))));
    await doc.fonts?.ready;
    const canvas = await html2canvas(doc.querySelector('.sheet'), { scale: 2, backgroundColor: '#ffffff', windowWidth: 850, logging: false });

    const pdf = new jsPDF({ unit: 'mm', format: 'a4' });
    const pw = PAGE.w - 2 * PAGE.margin;
    const ph = PAGE.h - 2 * PAGE.margin;
    const fullH = (canvas.height * pw) / canvas.width;
    if (fullH <= ph * 1.35) {
      // Fits on one page (shrunk a little if needed), which covers almost every payslip.
      const scale = Math.min(1, ph / fullH);
      pdf.addImage(canvas.toDataURL('image/jpeg', JPEG_QUALITY), 'JPEG', PAGE.margin + (pw - pw * scale) / 2, PAGE.margin, pw * scale, fullH * scale, undefined, 'FAST');
    } else {
      // Long documents continue on more pages.
      const slicePx = Math.floor((ph * canvas.width) / pw);
      for (let y = 0, first = true; y < canvas.height; y += slicePx, first = false) {
        const part = document.createElement('canvas');
        part.width = canvas.width;
        part.height = Math.min(slicePx, canvas.height - y);
        const ctx = part.getContext('2d');
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, part.width, part.height);
        ctx.drawImage(canvas, 0, -y);
        if (!first) pdf.addPage();
        pdf.addImage(part.toDataURL('image/jpeg', JPEG_QUALITY), 'JPEG', PAGE.margin, PAGE.margin, pw, (part.height * pw) / part.width, undefined, 'FAST');
      }
    }
    return pdf.output('blob');
  } finally {
    frame.remove();
  }
}

// Letters, numbers, spaces and a few safe signs only, so the names work on Windows and Mac.
export const safeFileName = (s) => String(s).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, ' ').trim();

// docs: [{ path: 'Folder/File name.pdf', html }]. onProgress(done, total) is called as each file is made.
export async function downloadPdfZip(zipName, docs, onProgress = () => {}) {
  const libs = await loadLibs();
  const zip = new libs.JSZip();
  for (const [i, d] of docs.entries()) {
    onProgress(i, docs.length);
    zip.file(d.path, await htmlToPdf(d.html, libs));
  }
  onProgress(docs.length, docs.length);
  const blob = await zip.generateAsync({ type: 'blob' });
  const a = Object.assign(document.createElement('a'), { href: URL.createObjectURL(blob), download: zipName });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}
