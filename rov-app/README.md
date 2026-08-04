# ROV Assistant

A Reconsideration of Value (ROV) assistant for mortgage loan officers. Uploads an
appraisal report and MLS comparable sheets, then produces a submission-ready ROV
request that argues with the appraiser's own adjustment factors.

**Backend:** a static React frontend (GitHub Pages) that talks to a **Google Apps
Script** Web App proxy. The proxy holds the Anthropic key, forwards the PDFs, and
returns the finished ROV. Session-only; no server-side storage of appraisals.

> A Cloudflare Worker version (with token streaming) is kept in
> `_worker-cloudflare-alternative/` if you ever want to switch back.

See `ARCHITECTURE.md` for the decision record, `LAUNCH_CHECKLIST.md` for the
step-by-step config, and `LOCAL_TESTING.md` for trying it before you ship.

---

## Repository layout

```
rov-app/
├── web/                     # React SPA (deploys to GitHub Pages)
│   ├── src/
│   │   ├── App.jsx          # the app
│   │   ├── api.js           # talks to the Apps Script Web App
│   │   └── export.js        # DOCX + PDF export (client-side)
│   ├── index.html
│   ├── package.json
│   └── vite.config.js
├── appscript/               # Google Apps Script backend (the proxy)
│   ├── Code.gs              # doPost/doGet, CORS-simple, rate limit, Anthropic call
│   └── Prompt.gs            # SYSTEM_PROMPT + buildUserMessage (server-side, hidden)
├── .github/workflows/
│   └── deploy-web.yml       # builds web/ and publishes to GitHub Pages
├── _worker-cloudflare-alternative/   # optional streaming backend (unused)
├── LAUNCH_CHECKLIST.md
├── LOCAL_TESTING.md
├── ARCHITECTURE.md
└── README.md
```

---

## Quick start

1. **Apps Script backend** — create a project, paste `appscript/Code.gs` and
   `appscript/Prompt.gs`, set Script Properties (`ANTHROPIC_API_KEY`, `APP_TOKEN`),
   deploy as a Web App (Execute as *Me*, Access *Anyone*). Copy the `/exec` URL.
2. **Web app** — set `VITE_API_BASE` (the `/exec` URL) and `VITE_APP_TOKEN`
   (matching `APP_TOKEN`) in `web/.env`, then `npm install && npm run dev`.
3. **Deploy** — push to GitHub; the Actions workflow builds `web/` to Pages.
   Set `VITE_API_BASE` (repo Variable) and `VITE_APP_TOKEN` (repo Secret).

Full details in `LAUNCH_CHECKLIST.md`.

---

## Security posture

- API key: only ever a Script Property on the Apps Script side. Never in the
  client bundle, never in git.
- `APP_TOKEN`: a shared secret the client sends and the script verifies, so random
  callers can't spend your key even though the Web App is reachable.
- Session-only: appraisal PDFs live in the browser and the single in-flight
  request. The script does not save them to Drive or logs.
- Rate limit: per-browser daily cap in the script (default 40).
- Set a monthly spend cap in the Anthropic console as a backstop.

---

## Build order status

1. ✅ Repo + deploy scaffold
2. ✅ Real call: appraisal PDF → backend → Anthropic → ROV
3. ✅ Multi-document (comps + prior as separate blocks; page/size checks)
4. ⏳ Prompt caching (appraisal block is cache-flagged; Files API optional later)
5. ⏳ OCR fallback for poor scans (model reads most scans natively)
6. ✅ DOCX/PDF export (client-side, `web/src/export.js`)
7. ✅ Deploy config — GitHub Pages + Apps Script (see LAUNCH_CHECKLIST.md)
