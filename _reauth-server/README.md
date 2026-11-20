# Auth Checker server: setup guide

The Auth Checker page lives at **cloversva.org/reauth/**. This small server is the
only part that sees patient text. It:

1. checks that the person is signed in to the CloversVA Time Tracker and allowed to
   use the Auth app (admins always are; VAs need "Can use the Auth app" ticked),
2. sends the files' text to Claude with your Anthropic API key, and
3. returns the filled form. It stores nothing and logs only error codes.

It runs on **AWS Lambda**, which is covered by AWS's HIPAA BAA. Your API key stays on
AWS and never reaches anyone's browser.

| Part | Where | Holds patient data? |
|---|---|---|
| The page | GitHub Pages (`reauth/`) | No. Files are read in the browser. |
| Sign-in and staff list | Firebase (Time Tracker) | No. Staff names and emails only. |
| This server | AWS Lambda, under the AWS BAA | Passes through only. Not stored or logged. |
| Claude | Anthropic, under your Anthropic BAA | Per your Anthropic BAA. |
| Pending list, HIPAA agreement record | Each person's browser | Auth numbers only, on that computer. |

Plan on about 30–45 minutes. Do the steps in order.

## Step 1: AWS account and BAA

1. Sign in at **aws.amazon.com** (or create an account) with a work email.
2. Search for **AWS Artifact**, open **Agreements**, then accept the **AWS Business
   Associate Addendum (BAA)** for this account.
3. In the top-right region menu, pick **US East (N. Virginia)** (or the US region nearest you). Use the same region for every step.

## Step 2: Anthropic API key

1. In the Anthropic Console (**platform.claude.com**), use the organization covered by
   your BAA. Create a workspace named `reauth`, and set a **monthly spend limit** on it.
2. In that workspace, create an API key named `cloversva-reauth`. Copy it; you paste
   it into AWS in Step 4 and nowhere else. Never put it in GitHub or email.

## Step 3: Create the function

1. In AWS, search for **Lambda**, then click **Create function**.
2. Choose **Author from scratch**. Name: `cloversva-reauth`. Runtime: **Node.js 22.x**.
   Click **Create function**.
3. On the **Code** tab, click **Upload from**, then **.zip file**, and upload
   `function.zip` (Claude sent it to you; to build it yourself, run `npm run zip` in
   this folder). Click **Save**.

## Step 4: Settings

On the **Configuration** tab:

1. **General configuration**, then **Edit**: Memory `512` MB, Timeout `5` min `0` sec. Save.
2. **Environment variables**, then **Edit**, then add:
   - `ANTHROPIC_API_KEY` = the key from Step 2.
   - Optional: `CLAUDE_MODEL` (default `claude-sonnet-5-5`). Use `claude-opus-5-5`
     for the most capable model, at about twice the cost.
3. **Concurrency**, then **Edit**: choose **Reserve concurrency** and enter `5`. This
   caps how many requests can run at once, which limits cost if something goes wrong.

## Step 5: Give it a web address

1. **Configuration**, then **Function URL**, then **Create function URL**.
2. Auth type: **NONE**. The server checks each person's Time Tracker sign-in itself.
3. **Leave "Configure cross-origin resource sharing (CORS)" unticked.** The server
   already allows only cloversva.org. Ticking it breaks the page.
4. Click **Save**, then copy the **Function URL** (it looks like
   `https://abc123.lambda-url.us-east-1.on.aws/`).

## Step 6: Connect the page

1. On GitHub, open `reauth/config.js`, click the pencil icon, and paste the URL between
   the quotes: `serverUrl: "https://abc123.lambda-url.us-east-1.on.aws/"`.
2. Commit to `main`. GitHub Pages updates the site in a minute or two.

## Step 7: Keep logs short

1. In Lambda, open **Monitor**, then **View CloudWatch logs**.
2. Click **Actions**, then **Edit retention setting**, and choose **1 month**.

## Step 8: Firestore rules (in the Firebase console)

The Time Tracker's Firestore rules are not in this repository. Check them once in
**console.firebase.google.com**, project `va-time-tracker-fabd7`, then **Firestore**, then **Rules**:

- A signed-in person must be able to **read their own** `allowed/{email}` record (the
  Time Tracker already needs this).
- **Only admins** may write `allowed` records. Otherwise a VA could tick their own
  "Can use the Auth app".
- If the rules list which fields an `allowed` record may have, add `authApp`.

## Step 9: Test

1. In the Time Tracker, open **Admin**, then **VAs**, click **Edit** on a VA, tick
   **Can use the Auth app**, then **Save**.
2. Have that VA open **cloversva.org/reauth/**, sign in with the same account they
   use for the Time Tracker, and accept the HIPAA agreement.
3. In step 4, upload one patient's files, click **Fill the form**, and compare the
   result with a form filled by hand.
4. Untick the box for a VA and check that their page is locked again.

## Changing things later

| To change | Edit | Then |
|---|---|---|
| What Claude is told | `_reauth-server/prompt.js` | Rebuild `function.zip` and upload it (Step 3) |
| Claude model | Lambda environment variable `CLAUDE_MODEL` | Save. It takes effect immediately. |
| The page | `_reauth-src/index.template.html` | `python3 _reauth-src/build.py`, then commit |
| The Word form | `_reauth-src/ReAuth_Request_Template.docx` (keep the «merge fields») | `python3 _reauth-src/build.py`, then commit |
| Who can use it | Time Tracker, Admin, VAs, Edit, "Can use the Auth app" | Takes effect immediately |
| Replace the API key | Create a new key in Anthropic, paste it into the Lambda env var, delete the old key | Save |

## Troubleshooting

| What you see | What to do |
|---|---|
| "The server address is not set yet" | Do Step 6. |
| "Claude could not be reached" | Check `ANTHROPIC_API_KEY` in Step 4 and the workspace spend limit. In CloudWatch logs, look for "Claude call failed" and its status. |
| "An admin has not switched on the Auth app for you yet" | Tick "Can use the Auth app" for that VA, and check that they are Active. |
| "Your access could not be checked" | Check Step 8: the person must be able to read their own `allowed` record. |
| "Sign in first" right after signing in | The page and server must use the same Firebase project (`va-time-tracker-fabd7`). |
| Nothing happens and the browser console mentions CORS | Untick CORS on the Function URL (Step 5). |
