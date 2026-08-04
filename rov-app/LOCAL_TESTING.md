# Local Test Guide — try it before you launch

With the Apps Script backend, there's no local server to run for the proxy — the
Apps Script Web App is already "deployed" the moment you publish it. So local
testing means: run the **web app** locally against your **deployed** Apps Script
`/exec` URL.

> Do Part 2 of `LAUNCH_CHECKLIST.md` first (create + deploy the Apps Script Web
> App, get the `/exec` URL and your `APP_TOKEN`). You need those two values.

---

## 1. Point the web app at your backend

```bash
cd rov-app/web
cat > .env <<ENV
VITE_API_BASE=https://script.google.com/macros/s/XXXXXXXX/exec
VITE_APP_TOKEN=your-app-token-that-matches-the-script-property
ENV
```

`.env` is gitignored. `VITE_APP_TOKEN` must equal the `APP_TOKEN` Script Property.

## 2. Run it

```bash
npm install
npm run dev
```

Open the printed URL (http://localhost:5173).

> No CORS setup needed. The client posts as `text/plain`, which is a "simple"
> request — no preflight — so a localhost origin calling your deployed `/exec`
> works out of the box.

---

## 3. Drive it against the Kuhio file

1. **Case facts**
   - Subject address: `5-2841 A Kuhio Hwy, Kilauea, HI 96754`
   - Borrower: `Corey Austin`
   - Appraised value: the report's reconciled value
   - Target value range (internal): e.g. `$4.28M–$4.58M`
2. **Deal-specific issues** — paste the real ones:
   - `Lower-level room classified as a bedroom in the Nov 2025 prior appraisal is now a family room, dropping the count from 5 to 4 — request reconciliation.`
   - `Kitchen and baths renovated < 1 year before inspection but subject rated C3 with no condition credit vs un-renovated comps.`
   - `All five report comps are below the subject's 4,141 sf — GLA not bracketed.`
3. **Evidence**
   - Appraisal PDF → appraisal zone (`APP-01`)
   - MLS comp PDFs → comparable-sales zone (`CMP-01`, `CMP-02`, …), in priority order
   - Prior appraisal PDF (if available) → prior zone (`PRI-00`)
4. Click **Run analysis**. Wait ~30–60s (no live streaming). The finished ROV
   appears, with the collapsible "Internal Notes — do not submit" section.

---

## 4. What to check in the output

- **Uses the report's own factors** — adjustments cite the appraisal's $/sf,
  $/acre, etc., not invented ones.
- **Comps triaged** — primary comps gridded; land/context sales in narrative;
  weak ones excluded (reason in Internal Notes).
- **`[VERIFY]` items** — flag facts absent from the PDFs; check whether a doc
  failed to attach.
- **Target value never in the ROV body** — only referenced internally.
- **Word + PDF export** both produce clean, formatted documents.

---

## 5. Common snags

| Symptom | Fix |
|---|---|
| `Unauthorized.` | `VITE_APP_TOKEN` ≠ the script's `APP_TOKEN`. Match them; restart `npm run dev` after editing `.env`. |
| CORS error in console | Don't change the client's `text/plain` content-type to `application/json`. |
| `/exec` health check fails | Redeploy the Web App as a **New version** with access = Anyone. |
| `... is over 32MB` / `100 PDF pages` | Anthropic per-PDF limits. Split or shrink the PDF. |
| Nothing happens, no error | Confirm `VITE_API_BASE` in `.env` is the full `/exec` URL and the deployment is live (open it in a browser). |

---

## 6. When it works locally

You're ready to deploy the frontend (LAUNCH_CHECKLIST Part 3): push to GitHub,
set the repo Variable `VITE_API_BASE` and Secret `VITE_APP_TOKEN`, enable Pages.
The same backend serves both local and production — no change needed there.
