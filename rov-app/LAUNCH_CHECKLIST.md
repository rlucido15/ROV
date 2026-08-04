# Launch & Configuration Checklist — GitHub Pages + Google Apps Script

Follow top to bottom. Two systems to configure: the **Apps Script backend**
(holds the key, calls Anthropic) and the **GitHub Pages frontend** (the app the
loan officer uses). A shared secret (`APP_TOKEN`) ties them together.

Legend: ☐ = do this · ✅ = verify it worked

---

## Part 1 — Anthropic

- ☐ Create an API key at https://console.anthropic.com → **API Keys**.
- ☐ Set a **monthly spend limit** (Billing → Limits) as a backstop. Recommended
  for a small team: start low (e.g. $50) and raise as needed.
- ☐ Copy the key (`sk-ant-...`). You'll paste it into Apps Script, never into the
  web app or git.

---

## Part 2 — Google Apps Script backend

### 2a. Create the project
- ☐ Go to https://script.google.com → **New project**.
- ☐ Rename it "ROV Backend".
- ☐ Delete the default `Code.gs` contents. Paste in `appscript/Code.gs`.
- ☐ Add a second file (＋ → Script) named `Prompt` and paste `appscript/Prompt.gs`.
  (Apps Script concatenates all files, so the two globals become available.)

### 2b. Script Properties (secrets + config)
- ☐ **Project Settings** (gear icon) → **Script Properties** → Add:
  | Property | Value |
  |---|---|
  | `ANTHROPIC_API_KEY` | your `sk-ant-...` key |
  | `APP_TOKEN` | a long random string you generate (see below) |
  | `ANTHROPIC_MODEL` | `claude-sonnet-4-6` *(optional)* |
  | `MAX_TOKENS` | `8000` *(optional)* |
  | `RATE_LIMIT_PER_DAY` | `40` *(optional)* |
- ☐ Generate `APP_TOKEN` — any long random string. E.g. run in a terminal:
  `openssl rand -hex 24`   (keep it; the web app needs the same value).

### 2c. Runtime
- ☐ Project Settings → confirm **V8 runtime** is on (default).

### 2d. Deploy as a Web App
- ☐ **Deploy** → **New deployment** → gear → **Web app**.
  - Description: `ROV backend v1`
  - **Execute as:** `Me`
  - **Who has access:** `Anyone`   ← required; the token protects it, not the ACL
- ☐ **Deploy**. Approve the OAuth consent screen (it will warn it's unverified —
  that's normal for your own script; click Advanced → Go to project → Allow).
- ☐ Copy the **Web app URL** ending in `/exec`. This is your `VITE_API_BASE`.

### 2e. Verify the backend
- ✅ Open the `/exec` URL in a browser. You should see:
  `{"ok":true,"service":"rov-appscript"}`
- ✅ If you see a Google login or "needs authorization" page instead, re-check
  "Who has access = Anyone" and redeploy.

> **Every code change needs a redeploy.** Deploy → Manage deployments → edit
> (pencil) → **New version** → Deploy. Editing the script alone does NOT update
> the live `/exec` URL.

---

## Part 3 — GitHub repository

### 3a. Push the code
- ☐ Create a new GitHub repo (private is fine).
- ☐ Push the `rov-app/` contents to it (`web/`, `appscript/`, `.github/`, docs).
  The `.gitignore` already excludes `node_modules`, `.env`, and build output.

### 3b. Repo config for the build
- ☐ **Settings → Secrets and variables → Actions**:
  - **Variables** tab → New variable:
    - `VITE_API_BASE` = your Apps Script `/exec` URL
    - `VITE_BASE` = `/<repo-name>/` **only if** this is a project page
      (`user.github.io/repo`). Leave unset for a user page (`user.github.io`).
  - **Secrets** tab → New secret:
    - `VITE_APP_TOKEN` = the same `APP_TOKEN` value from step 2b
- ☐ **Settings → Pages → Build and deployment → Source: GitHub Actions**.

### 3c. Trigger the deploy
- ☐ Push to `main` (or Actions tab → "Deploy web to GitHub Pages" → Run workflow).
- ✅ Actions run goes green. The job summary prints the Pages URL.

---

## Part 4 — Connect the two & smoke test

- ✅ Open the GitHub Pages URL. The app loads.
- ✅ Fill the required case facts + deal issues, drop in the Kuhio appraisal PDF
  and a comp or two, click **Run analysis**.
- ✅ A finished ROV appears within ~30–60s (no live streaming — Apps Script
  returns the whole document at once).
- ✅ Click **Word** and **PDF** — both download / open cleanly.

If it errors, jump to **Troubleshooting** below.

---

## Part 5 — Lock it down (before real use)

- ☐ Confirm the API key appears **only** in Apps Script Script Properties — grep
  your repo to be sure: `git grep -i "sk-ant"` returns nothing.
- ☐ Confirm `APP_TOKEN` matches on both sides (Script Property == repo Secret).
- ☐ Anthropic monthly spend cap is set.
- ☐ `RATE_LIMIT_PER_DAY` set to something sane for your team size.
- ☐ (Optional) Restrict the repo and Pages site visibility if the tool is internal.

---

## Troubleshooting

| Symptom | Cause / fix |
|---|---|
| `/exec` shows a Google login page | "Who has access" isn't **Anyone**, or you didn't redeploy after changing it. |
| Browser console: **CORS / preflight** error | The client must send `Content-Type: text/plain` (it does). If you edited `api.js`, don't switch it to `application/json` — that triggers a preflight Apps Script can't answer. |
| `Unauthorized.` in the app | `VITE_APP_TOKEN` (web) ≠ `APP_TOKEN` (script). Re-set both and redeploy both. |
| `Server not configured (missing API key)` | `ANTHROPIC_API_KEY` Script Property missing/typo. |
| `Upstream error (400)` mentioning **100 PDF pages** | One PDF exceeds 100 pages. Split the appraisal or send fewer pages. |
| `... is over 32MB` | A single PDF exceeds the Anthropic per-file limit. Compress/split it. |
| Runs a long time then fails | Apps Script's ~6-min ceiling. Reduce the number/size of PDFs in one request. |
| Old behavior after a code change | You edited the script but didn't **New version** redeploy. |
| Pages shows a blank page / 404 on assets | `VITE_BASE` wrong for a project page. Set it to `/<repo>/` and rebuild. |

---

## What changes on future updates

- **Prompt change** → edit `appscript/Prompt.gs`, redeploy a New version.
- **Frontend change** → push to `main`; Actions redeploys Pages automatically.
- **New API key** → update the `ANTHROPIC_API_KEY` Script Property (no redeploy of
  the frontend needed).
