// Builds the instructions for Claude. Used by reauth/index.html.
// Pure functions only: tested without Firebase or network.

const MAX_DOC_CHARS = 40000;
const MAX_DOCS = 12;

function cleanDocuments(documents) {
  if (!Array.isArray(documents)) return [];
  return documents.slice(0, MAX_DOCS).map(d => ({
    label: String((d && d.label) || 'Document').slice(0, 80),
    name: String((d && d.name) || '').slice(0, 200),
    text: String((d && d.text) || '').slice(0, MAX_DOC_CHARS),
  })).filter(d => d.text.trim());
}

const NEW_ADMIT_RULES = "THIS IS A NEW ADMISSION (initial authorization). The documents are the agency's intake form and, if provided, the hospital or facility discharge paperwork. These new-admission rules replace any conflicting rule further below:\n- request: initial = true; continuation, dateExtension and newModality = false. authNumber = \"\".\n- services: one entry per discipline the intake or discharge orders refer the patient for (SN, PT, OT, SLP, MSW, HHA). units = \"6\" for each. start = the day after the request date (today + 1 day); end = start + 30 days.\n- modality: true for each requested discipline.\n- clinicalComments: ONE short sentence only, e.g. \"SN and PT are for new admit.\"\n- practitioner: the referring or ordering physician (or the PCP who will sign orders) from the intake or discharge paperwork.\n- diagnosis1 / diagnosis2 / additionalIcd10: from the intake referral diagnoses and the discharge diagnoses; diagnosis1 = the main reason for home health.\n- caregiver, caregiverCompetency and goalsDocumented: \"N/A\". weeklyFrequency: \"To be determined\".\n- lastUnit: \"N/A\" for every discipline. lastRequest: both \"\".\n- clinicalAttached: \"Yes\" (the intake and discharge paperwork are sent with the form).";

function buildPrompt({ documents, extra, today, mode }) {
  const todayStr = /^\d{2}\/\d{2}\/\d{4}$/.test(String(today || '')) ? today : '';
  const docs = cleanDocuments(documents).map(d => `=== ${d.label}: ${d.name} ===\n${d.text}`).join('\n\n');
  const extraText = String(extra || '').trim().slice(0, 2000);
  return `You are filling a home health reauthorization request form ("Johns Hopkins Care at Home Authorization Request Form") for a home health agency, using only the Axxess documents below. Today is ${todayStr}.

Rules:
${mode === 'newadmit' ? NEW_ADMIT_RULES + '\n' : ''}- Use only facts in the documents. Never invent names, numbers, codes or dates. If something is not in the documents, leave it "" and add a review note.
- Dates as MM/DD/YYYY.
- insuranceType: one of "Medicare Adv", "PPMCO", "EHP", "USFHP", "Other". Payment source "Priority Partners" means PPMCO. If there is a secondary insurance, append it, e.g. "PPMCO; secondary: Medicaid 1234".
- memberId: the primary insurance member ID.
- copay: only one of "EHP 10% copay", "Med Adv 20% copay (HME/IV)", "Med Adv 0% copay (HH)", "USFHP 0% copay (active/retiree)", "USFHP 20% copay (with Medicare B)" when it clearly applies to the plan; otherwise "".
- For each discipline on the active auth, visits left = Auth. Units - Units Used. If more than 2 are left, request an EXTENSION: units = the Auth. Units of the current auth (the authorized units, not the visits left), start = the current Auth. Start Date, end = the Auth. End Date + 30 days. If 2 or fewer are left, request a REAUTH: units = 12, start = the day after the Auth. End Date, end = the Auth. End Date + 30 days. If NO visits are left (exhausted), do not use the Auth. End Date: start = the day after the last scheduled visit for that discipline (lastScheduled), end = that start + 30 days.
- Request type: continuation = true if any discipline is a reauth; dateExtension = true if any discipline is an extension. newModality = a discipline is needed that is not on the current auth. initial = no current auth.
- authNumber: the current Auth. Number for this patient.
- modality: true for each discipline you are requesting.
- services: one entry per discipline on the active auth (SN, PT, OT, SLP, MSW, HHA), following the extension/reauth rule above.
- practitioner: from the plan of care / profile (name, NPI, office phone and fax, full address).
- diagnosis1 / diagnosis2: the plan of care primary and first other diagnosis, as "CODE Description". additionalIcd10: the other codes from the plan of care and profile (including the admission diagnosis if different), comma-separated codes only.
- clinicalComments: ONE short sentence only, saying which disciplines are for reauth and which are for extension, e.g. "SN and PT are for reauth; OT is for extension." Nothing else.
- caregiver: only who the caregiver is, as relationship and name, e.g. "Daughter, Brenda Cruz". No other details. If there is no caregiver, "None".
- caregiverCompetency: "Yes" whenever the patient has a caregiver; otherwise "".
- goalsDocumented: start with Yes or No, then cite the note and date.
- weeklyFrequency: per discipline, e.g. "SN 2x/week (ordered 2w4); PT 2x/week".
- lastScheduled: for SN, PT, OT, HHA, SW, SLP, the LATEST visit date listed for that discipline on the patient chart or calendar (visit schedule) within the current auth dates, whatever its status: completed, scheduled, Not Yet Due, Not Yet Started, missed or any other. Take it only from the chart or calendar, never from the date of a visit note. Only the date, as MM/DD/YYYY; "" when none.
- lastUnit: for SN, PT, OT, HHA, SW, SLP, the date of the last visit for that discipline within the current auth dates, from the calendar or visit schedule. Count every listed visit regardless of its status (completed, scheduled, not started, missed or any other status); do not add review notes about visit status. Write "N/A" when the discipline is not on the auth, or "None used (0 of N units)" when no visits are listed.
- visitCheck: one entry per discipline (SN, PT, OT, SLP, MSW, HHA) that has an ordered frequency in the plan of care or orders AND visits on the calendar or patient chart. Leave it [] when there is no calendar or visit schedule in the documents.
  - frequency: the ordered frequency written only as comma-separated nWm parts in order, e.g. "1W1, 2W4, 1W3" (n visits a week for m weeks). Write a range like "1-2W4" as it is. Leave out PRN visits.
  - frequencyStart: the date the ordered frequency starts (the start of care, resumption or recertification period, or the order date for that frequency), MM/DD/YYYY.
  - visits: EVERY visit for that discipline listed on the calendar or chart from frequencyStart onward, each {"date":"MM/DD/YYYY","status":"..."} with the status exactly as shown (Completed, Scheduled, Not Yet Due, Not Yet Started, Missed Visit, etc.). Count OASIS, recert and supervisory visits done by that discipline. Take them only from the calendar or chart, never from visit note dates.
- clinicalAttached: "Yes" if visit notes or a plan of care were provided (they will be faxed with the form), else "".
- lastRequest: the most recent earlier authorization or reauthorization REQUEST for this patient. If a "Last authorization request" document is provided, use it: date = its "Today's Date", detail = a short summary such as "Continuation + Date Extension, Auth #123: SN 12, PT 12 (11/22–12/21/2026)" (request types that are checked ☒, disciplines with units and dates). Otherwise use any request the other documents explicitly mention (e.g. communication notes). Never treat a visit date or the auth start date as a request date. If none, leave both "". The last request is reference only: do not copy its values into the new form.
- reviewNotes: short plain-English points the person must check before faxing (estimates you made, conflicts between documents, missing information). 2-8 items.
${extraText ? `\nInstructions from the person filling the form (follow these over the rules above):\n${extraText}\n` : ''}
Reply with only one JSON object, exactly this shape:
{"today":"${todayStr}","request":{"initial":false,"continuation":false,"dateExtension":false,"newModality":false},"authNumber":"","modality":{"sn":false,"pt":false,"ot":false,"st":false,"msw":false,"dme":false},"practitioner":{"name":"","npi":"","phone":"","address":""},"clinicalAttached":"","member":{"lastName":"","firstName":"","middleInitial":"","dob":"","memberId":"","address":""},"insuranceType":"","copay":"","diagnosis1":"","diagnosis2":"","additionalIcd10":"","services":[{"discipline":"SN","units":"","start":"","end":""}],"clinicalComments":"","caregiver":"","caregiverCompetency":"","goalsDocumented":"","weeklyFrequency":"","lastUnit":{"SN":"","PT":"","OT":"","HHA":"","SW":"","SLP":""},"lastScheduled":{"SN":"","PT":"","OT":"","HHA":"","SW":"","SLP":""},"visitCheck":[{"discipline":"SN","frequency":"","frequencyStart":"","visits":[{"date":"","status":""}]}],"lastRequest":{"date":"","detail":""},"reviewNotes":[""]}

Documents:

${docs}`;
}

// Reads Claude's reply as one JSON object: the whole reply, a fenced block, or the first { to the last }.
function parseJsonReply(text) {
  const t = String(text || '').trim();
  const tries = [t];
  const fence = t.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) tries.push(fence[1]);
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) tries.push(t.slice(a, b + 1));
  for (const x of tries) {
    try { const v = JSON.parse(x); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch (e) { /* next */ }
  }
  return null;
}

// VA authorization: Claude reads the visit notes (and the profile), explains them simply, estimates the visits needed and writes the justification.
function buildVaPrompt({ documents, discipline, extra, today }) {
  const hint = ['SN', 'PT', 'OT', 'ST', 'HHA', 'MSW'].includes(discipline) ? discipline : '';
  const docs = cleanDocuments(documents).map(d => `=== ${String(d.label || 'Document').slice(0, 80)}: ${String(d.name || '').slice(0, 200)} ===\n${String(d.text || '').slice(0, 40000)}`).join('\n\n');
  const note = String(extra || '').slice(0, 2000);
  return `A home health agency is asking the VA (Veterans Affairs community care) to approve more visits for a veteran patient. Read the documents below (visit notes, the calendar and the patient profile, if given) and help the staff member. Today is ${String(today || '').slice(0, 10)}.${hint ? ` The staff expect the request to be for ${hint}.` : ''}${note ? `\nStaff note: ${note}` : ''}

Answer with JSON only, in this shape:
{"patient":{"title":"","firstName":"","lastName":""},"discipline":"SN","lastVisit":"","visitsNeeded":0,"visitsWhy":"","interpretation":[""],"justification":"","checks":[""]}

Rules:
- patient: title = "Mr." for a male patient, "Ms." for a female patient, "" if not clear. firstName and lastName as written (no middle name).
- discipline: the discipline the extra visits are for, one of SN, PT, OT, ST, HHA, MSW (the discipline of the visit notes).
- lastVisit: the LAST visit date of that discipline on the patient chart or calendar (the visit schedule), whatever its status: completed, scheduled, Not Yet Due, Not Yet Started, missed or any other. Take it only from the chart or calendar, never from the date of a visit note. As MM/DD/YYYY; "" if there is no chart or calendar.
- visitsNeeded: a whole number, how many MORE visits of that discipline the patient will most likely need to reach the goals in the notes. Base it on the ordered frequency and length (e.g. "2x a week for 4 weeks"), the goals not yet met and how fast the patient is improving. Be realistic and do not pad the number.
- visitsWhy: one short sentence on how you got that number.
- interpretation: 3 to 6 short bullets in plain everyday English that explain what the notes show: the main problems, how the patient is doing now, what the visits do for them, risks (falls, wounds, medicines, vital signs, ER or hospital visits, living alone) and goals not yet met.
- justification: exactly 2 sentences in this style:
  "Patient is a 72-year-old wheelchair-bound male with a right BKA, left toe amputations and generalized weakness. He needs additional SN visits to monitor and teach on insulin-dependent Type 2 diabetes, on anticoagulation therapy and on urinary retention with frequency and urgency after his hospital discharge, to prevent complications and rehospitalization."
  Sentence 1: "Patient is a [age]-year-old [how they get around, if stated] [male/female] with [main conditions]." Work out the age from the date of birth and today's date.
  Sentence 2: "[He/She] needs additional [discipline] visits to [what the visits do, e.g. monitor and teach on, provide wound care for] [the conditions and treatments][, after [recent event such as a hospital discharge], if there was one], to prevent complications and rehospitalization."
  Use only facts from the documents. Common abbreviations such as BKA are fine. No name and no ID numbers.
- checks: short notes on anything the staff member should check (unclear or missing information, notes that seem old or for a different discipline, no age or sex found). Use [] when there is nothing.
- Use only what the documents say. Do not invent facts.

${docs}`;
}

// Auth approval: Claude reads approval emails or letters and returns each patient's decision.
function buildApprovalPrompt({ documents, today }) {
  const docs = cleanDocuments(documents).map(d => `=== ${String(d.label || 'Approval').slice(0, 80)}: ${String(d.name || '').slice(0, 200)} ===\n${String(d.text || '').slice(0, 40000)}`).join('\n\n');
  return `A home health agency received replies from a payer (usually Johns Hopkins Care at Home or the VA) about authorization requests. The documents below may cover one patient or several. Read them and pull out each decision. Today is ${String(today || '').slice(0, 10)}.

Answer with JSON only, in this shape:
{"approvals":[{"patient":{"lastName":"","firstName":""},"authNumber":"","decision":"approved","services":[{"discipline":"SN","units":"","start":"","end":""}],"checks":[""]}]}

Rules:
- approvals: one entry per patient. If one patient has two different auth numbers, give one entry per auth number.
- patient: the patient's last and first name as written (no middle name).
- authNumber: the authorization number the payer gives. "" if none is shown.
- decision: "approved", "partly approved" (fewer visits or a shorter period than asked), "denied", "pending" (still under review or more information requested) or "unclear".
- services: one entry per approved discipline. discipline is one of SN, PT, OT, ST, MSW, HHA. units = the number of visits approved, as a number only. start and end = the approved dates as MM/DD/YYYY. Leave a value "" when it is not shown.
- checks: short notes on anything unclear or that the staff should double-check (e.g. fewer visits approved than requested, missing dates). [] when nothing.
- Use only what the documents say. Do not invent anything.

${docs}`;
}

export { buildPrompt, buildVaPrompt, buildApprovalPrompt, parseJsonReply, cleanDocuments };
