'use strict';
// Server for the Auth Checker (cloversva.org/reauth/), run on AWS Lambda behind a Function URL.
// It checks that the caller is signed in to the CloversVA Time Tracker and allowed to use the
// Auth app, sends the patient text to Claude, and returns the filled fields.
// Patient text is never stored or logged: only error codes are logged.

const crypto = require('node:crypto');
const Anthropic = require('@anthropic-ai/sdk');
const { buildPrompt, buildVaPrompt, buildApprovalPrompt, parseJsonReply } = require('./prompt');

// Settings come from the Lambda's environment variables (see README.md).
const FIREBASE_PROJECT = process.env.FIREBASE_PROJECT || 'va-time-tracker-fabd7';
const CLAUDE_MODEL = process.env.CLAUDE_MODEL || 'claude-sonnet-5-5';
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS || 'https://cloversva.org,https://www.cloversva.org')
  .split(',').map(s => s.trim()).filter(Boolean);

const client = new Anthropic(); // reads ANTHROPIC_API_KEY from the environment

// ---------- Firebase sign-in check (no Google SDK or service account needed) ----------

const CERTS_URL = 'https://www.googleapis.com/robot/v1/metadata/x509/securetoken@system.gserviceaccount.com';
let certs = null, certsUntil = 0;

async function googleCerts() {
  if (certs && Date.now() < certsUntil) return certs;
  const res = await fetch(CERTS_URL);
  if (!res.ok) throw new Error('certs');
  const maxAge = Number((/max-age=(\d+)/.exec(res.headers.get('cache-control') || '') || [])[1]) || 3600;
  certs = await res.json();
  certsUntil = Date.now() + maxAge * 1000;
  return certs;
}

const b64json = s => JSON.parse(Buffer.from(s, 'base64url').toString('utf8'));

// Returns the token's claims if it is a valid, unexpired Firebase ID token for our project.
async function verifyIdToken(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  let header, claims;
  try { header = b64json(parts[0]); claims = b64json(parts[1]); } catch { return null; }
  if (header.alg !== 'RS256' || !header.kid) return null;
  const pem = (await googleCerts())[header.kid];
  if (!pem) return null;
  const ok = crypto.verify('RSA-SHA256', Buffer.from(`${parts[0]}.${parts[1]}`),
    crypto.createPublicKey(pem), Buffer.from(parts[2], 'base64url'));
  if (!ok) return null;
  const now = Math.floor(Date.now() / 1000);
  if (claims.aud !== FIREBASE_PROJECT) return null;
  if (claims.iss !== `https://securetoken.google.com/${FIREBASE_PROJECT}`) return null;
  if (!claims.sub || !(claims.exp > now) || !(claims.iat <= now + 60)) return null;
  if (!claims.email || claims.email_verified !== true) return null;
  return claims;
}

// Reads the caller's own Time Tracker record (allowed/{email}) with their own sign-in,
// so the Firestore rules apply exactly as they do in the Time Tracker.
async function mayUse(token, email) {
  const url = `https://firestore.googleapis.com/v1/projects/${FIREBASE_PROJECT}/databases/(default)/documents/allowed/${encodeURIComponent(email.toLowerCase())}`;
  const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return false;
  const f = (await res.json()).fields || {};
  const active = f.active && f.active.booleanValue === true;
  const admin = f.role && f.role.stringValue === 'admin';
  const authApp = f.authApp && f.authApp.booleanValue === true;
  return active && (admin || authApp);
}

// ---------- HTTP ----------

function reply(origin, status, body) {
  const headers = { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', Vary: 'Origin' };
  if (ALLOWED_ORIGINS.includes(origin)) {
    Object.assign(headers, {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
    });
  }
  return { statusCode: status, headers, body: body === undefined ? '' : JSON.stringify(body) };
}
const fail = (origin, status, code, message) => reply(origin, status, { error: { code, message } });

exports.handler = async (event) => {
  const h = Object.fromEntries(Object.entries(event.headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
  const origin = h.origin || '';
  const method = (event.requestContext && event.requestContext.http && event.requestContext.http.method) || 'POST';
  if (method === 'OPTIONS') return reply(origin, 204);
  if (method !== 'POST') return fail(origin, 405, 'invalid-argument', 'Use POST.');
  if (!ALLOWED_ORIGINS.includes(origin)) return fail(origin, 403, 'permission-denied', 'This page is not allowed to use the server.');

  const token = (/^Bearer\s+(.+)$/i.exec(h.authorization || '') || [])[1];
  let claims;
  try { claims = await verifyIdToken(token); } catch { return fail(origin, 503, 'unavailable', 'Sign-in could not be checked. Try again in a minute.'); }
  if (!claims) return fail(origin, 401, 'unauthenticated', 'Sign in first.');
  try {
    if (!(await mayUse(token, claims.email))) return fail(origin, 403, 'permission-denied', 'An admin has not switched on the Auth app for you yet.');
  } catch { return fail(origin, 503, 'unavailable', 'Your access could not be checked. Try again in a minute.'); }

  let data;
  try {
    const raw = event.isBase64Encoded ? Buffer.from(event.body || '', 'base64').toString('utf8') : (event.body || '');
    data = JSON.parse(raw);
  } catch { return fail(origin, 400, 'invalid-argument', 'The request could not be read.'); }

  const { documents, extra, today, mode, discipline } = data || {};
  const prompt = mode === 'approval'
    ? buildApprovalPrompt({ documents, today: String(today || '').slice(0, 10) })
    : mode === 'va'
    ? buildVaPrompt({ documents, discipline, extra, today: String(today || '').slice(0, 10) })
    : buildPrompt({ documents, extra, today, mode: mode === 'newadmit' ? 'newadmit' : 'reauth' });
  if (!/=== /.test(prompt)) return fail(origin, 400, 'invalid-argument', 'No readable files were sent.');

  let msg;
  try {
    msg = await client.messages.create({
      model: CLAUDE_MODEL,
      max_tokens: 16000,
      messages: [{ role: 'user', content: prompt }],
    });
  } catch (e) {
    // Log only the error type and status, never the request or patient text.
    console.error('Claude call failed', { status: e && e.status, type: e && e.error && e.error.error && e.error.error.type });
    if (e instanceof Anthropic.RateLimitError) return fail(origin, 429, 'resource-exhausted', 'Too many requests right now. Wait a minute, then try again.');
    return fail(origin, 503, 'unavailable', 'Claude could not be reached. Try again in a minute.');
  }
  if (msg.stop_reason === 'refusal') {
    console.error('Claude declined', { category: msg.stop_details && msg.stop_details.category });
    return fail(origin, 422, 'internal', 'Claude declined to read these files. Check the uploads and try again.');
  }

  const text = (msg.content || []).filter(b => b.type === 'text').map(b => b.text).join('');
  const out = parseJsonReply(text);
  if (!out) return fail(origin, 502, 'internal', 'Claude’s answer could not be read. Try again.');
  return reply(origin, 200, out);
};
