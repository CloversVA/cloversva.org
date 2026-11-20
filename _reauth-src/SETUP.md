# Auth Checker: setup guide

The Auth Checker lives at **cloversva.org/reauth/**. There is no server: each staff
member's browser reads the patient files and sends their text straight to Claude
(Anthropic), under your BAA with Anthropic.

| Part | Where | Holds patient data? |
|---|---|---|
| The page | GitHub Pages (`reauth/`) | No. Files are read in the browser. |
| Sign-in and staff list | Firebase (Time Tracker) | No. Staff names and emails only. |
| Claude API key | Firebase, `reauthKey/current` | No. Only admins and approved VAs can read it. |
| Claude | Anthropic, under your BAA | Per your Anthropic BAA. |
| Pending list, HIPAA agreement record | Each person's browser | Auth numbers only, on that computer. |

**About the key:** each approved person's browser receives the API key in order to call
Claude. Someone tech-savvy could copy it. The spend limit (step 1) caps any misuse.
When someone leaves, untick their access **and replace the key** (see "Replacing the key").

Plan on about 15 minutes.

## Step 1: Create the Anthropic API key

1. Sign in at **platform.claude.com** with the organization covered by your BAA.
2. Go to **Settings**, then **Workspaces**, and click **Create workspace**. Name it
   `reauth`. Make sure it's set up the way your BAA requires (for example, the
   data-retention setting).
3. Open the workspace and set a **monthly spend limit**, for example $50.
4. Go to **API keys**, then **Create key**. Choose the `reauth` workspace and name the
   key `cloversva-reauth`. Copy the key. You'll paste it in step 3, and nowhere else.

## Step 2: Add the Firestore rule (Firebase console)

The Time Tracker's rules live in Firebase, not in this repository.

1. Go to **console.firebase.google.com**, open project `va-time-tracker-fabd7`, then
   **Firestore Database**, then **Rules**.
2. Inside `match /databases/{database}/documents { ... }`, paste this block next to the
   other `match` blocks:

   ```
   // Auth Checker: the Claude API key. Admins and VAs with the Auth app switched on
   // can read it; only admins can change it.
   match /reauthKey/{docId} {
     function staff() {
       return get(/databases/$(database)/documents/allowed/$(request.auth.token.email.lower())).data;
     }
     function onStaff() {
       return request.auth != null && request.auth.token.email_verified == true
         && exists(/databases/$(database)/documents/allowed/$(request.auth.token.email.lower()))
         && staff().active == true;
     }
     allow read: if onStaff() && (staff().role == 'admin' || staff().get('authApp', false) == true);
     allow write: if onStaff() && staff().role == 'admin';
   }
   ```

3. While you're on that page, check the rule for `allowed`:
   - **Only admins** may write `allowed` records. Otherwise a VA could switch on their own access.
   - If the rule lists which fields an `allowed` record may have, add `authApp`.
4. Click **Publish**.

## Step 3: Save the key in the app

1. Open **cloversva.org/reauth/** and sign in as a Time Tracker admin.
2. Go to **4. Prepare the reauth request** and open **Admin: Claude API key**.
3. Paste the key. The model can stay `claude-sonnet-5-5`; use `claude-opus-5-5` for the
   most capable model, at about twice the cost. Click **Save**.
4. The box should then say "A key ending in …XXXX is saved".

## Step 4: Give VAs access and test

1. In the Time Tracker, go to **Admin**, then **VAs**, click **Edit** on a VA, tick
   **Can use the Auth app**, and click **Save**.
2. Have that VA open **cloversva.org/reauth/**, sign in with their Time Tracker account
   and accept the HIPAA agreement.
3. In step 4, upload one patient's files, click **Fill the form**, and compare the
   result with a form filled by hand.
4. Untick the box for that VA and check that their page locks again.

## Replacing the key

Do this when someone with access leaves, or at least every few months:

1. In the Claude Console, create a new key in the `reauth` workspace.
2. Paste it into **Admin: Claude API key** and click **Save**.
3. Delete the old key in the Claude Console.

## Changing things later

| To change | Edit | Then |
|---|---|---|
| What Claude is told | `reauth/prompt.js` (bump `prompt.js?v=N` in the template) | `python3 _reauth-src/build.py`, then commit |
| The page | `_reauth-src/index.template.html` | `python3 _reauth-src/build.py`, then commit |
| The Word form | `_reauth-src/ReAuth_Request_Template.docx` (keep the «merge fields») | `python3 _reauth-src/build.py`, then commit |
| Claude model | Admin: Claude API key, Model | Save. It takes effect right away. |
| Who can use it | Time Tracker, Admin, VAs, Edit, "Can use the Auth app" | Takes effect right away |
| Claude SDK version | `_reauth-src/sdk/package.json` | `npm install && npm run build` in that folder, bump `anthropic-sdk.js?v=N`, rebuild, commit |

## Troubleshooting

| What you see | What to do |
|---|---|
| "An admin needs to add the Claude API key" | Do step 3. |
| "The Claude API key could not be loaded" | Check the rule from step 2, and that the person is Active with the Auth app ticked. |
| "The Claude API key was refused" | The key was deleted or mistyped. Save a new one (step 3). |
| "Claude could not take this request" | Check the workspace spend limit in the Claude Console. |
| "The Claude model name is not recognized" | Fix the Model field in step 3. |
| "An admin needs to switch on the Auth app for you" | Tick "Can use the Auth app" for that VA (step 4). |
