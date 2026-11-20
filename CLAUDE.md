# CloversVA website (cloversva.org)

This repo is **CloversVA only** (Clovers Virtual Assistance). It is unrelated to
Stellar Clinic, which lives in the separate `Stellar-Clinic/Stellar` repo. Never
copy code, data, or settings between the two.

## What's here

- `index.html`, `contact.html` — public marketing site, plain HTML/CSS.
- `booking.js` — consultation calendar on `contact.html`. Booked call times are stored
  in Firestore `bookedSlots` (time only, no personal data); details go out by Web3Forms.
- `images/` — logos, icons, and the brochure PDF.
- `CNAME` — custom domain (`cloversva.org`) for GitHub Pages. Don't change it.
- `dtr/` — the **VA Time Tracker** (DTR = daily time record), served at
  `cloversva.org/dtr/`. This is where most active work happens.

## Time tracker (`dtr/`)

Static site, no build step. Plain JavaScript ES modules that load the Firebase
SDK from gstatic (Firebase Auth + Firestore, project `va-time-tracker-fabd7`).

- `app.js` — sign-in, approval check, VA view (clock in/out, my shifts, payslips, COE requests).
- `admin.js` — admin view: approving access requests, managing VAs and roles,
  timesheets, editing/deleting shifts (with an edit history), payroll, company details.
- `requests.js` — leave and overtime requests. `board.js` — announcements, holidays, birthdays.
- `files.js` — shared files. `docs.js` — printable payslip, invoice, COE, timesheet.
- `report.js` — time/period math. Business time zone is `America/New_York`;
  pay periods are bi-weekly from an anchor date (default `2026-10-11`).
- `ui.js` — DOM helpers. `firebase.js` / `firebase-config.js` — Firebase setup.

### Admin access

- Access is controlled by the Firestore `allowed` collection, keyed by email,
  with `role: 'admin' | 'va'` and `active: true/false`.
- New users sign in, which creates a `requests` entry; an admin approves it.
- The UI hiding admin screens is not security. Real enforcement is in Firestore
  security rules, which are managed in Firebase and are **not in this repo**.
  Any change to who can read or write what needs a matching rules change, so
  call that out.

## Auth Checker (`reauth/`)

Trust Home Care's Axxess Auth Checker, served at `cloversva.org/reauth/`. Handles
patient files (PHI), so keep patient data out of Firebase and GitHub.

- `reauth/index.html` is **built**: edit `_reauth-src/index.template.html`, then run
  `python3 _reauth-src/build.py` (it embeds the Word template). `reauth/prompt.js` holds
  Claude's instructions; `reauth/anthropic-sdk.js` is the Claude SDK bundled by
  `_reauth-src/sdk/` (no CDN).
- No server: the browser calls Claude directly (Anthropic BAA). The API key is in Firestore
  `reauthKey/current`, saved from the page's "Admin: Claude API key" box. A Firestore rule
  (in `_reauth-src/SETUP.md`, managed in the Firebase console) lets admins and Auth-app VAs
  read it and only admins write it.
- Sign-in reuses the Time Tracker's Firebase project. Access: `allowed/{email}` with
  `active: true` and either `role: 'admin'` or `authApp: true` (the "Can use the Auth app"
  box in the Time Tracker's VA editor).
- The pending list and the HIPAA agreement record stay in each browser (localStorage).
- Folders starting with `_` are not published by GitHub Pages.

## Working conventions

- Changes are usually uploaded straight to `main` through GitHub; GitHub Pages
  publishes `main` automatically.
- When changing a `dtr/` JS or CSS file, bump its `?v=N` cache-busting number
  in every import/link that references it so browsers pick up the new version.
- `firebase-config.js` values are public by design; never add real secrets,
  service-account keys, or VA personal/payroll data to the repo.
- Running locally on `localhost` points at the Firebase emulators
  (Auth :9099, Firestore :8080) instead of the live project.
- The owner is not a full-time developer: explain changes in plain language
  and say what to click or test to confirm they work.
