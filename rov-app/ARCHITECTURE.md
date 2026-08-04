# ROV Assistant — Architecture Decision Record

**Status:** Locked (v1) — **backend updated to Google Apps Script (v1.1)**
**Date:** August 2026
**Decision:** Static frontend on GitHub Pages + **Google Apps Script Web App** API
proxy, calling the Anthropic Messages API with native PDF document blocks.
Session-only, zero server-side storage of appraisal documents by default.

> **v1.1 note:** The original decision (below) chose a Cloudflare Worker. The
> project later switched the backend to Google Apps Script to fit an existing
> Google-centric workflow. Trade-offs accepted: **no streaming** (the ROV returns
> all at once rather than token-by-token) and a **~6-minute execution ceiling**
> (fine for one ROV). Everything else — the frontend, PDF handling, security
> model, prompt-hiding — is unchanged. CORS is handled by sending the request as
> `text/plain` (a "simple" request that skips the preflight Apps Script can't
> answer), and the key is protected by a shared `APP_TOKEN` plus Script
> Properties. The Cloudflare Worker version is retained in
> `_worker-cloudflare-alternative/` as a drop-in if streaming is wanted later.
> The rest of this document reflects the original Worker reasoning for context.

---

## 1. The decision in one paragraph

The React app already built stays a static single-page app, deployed on **GitHub Pages**. All calls to Claude route through a **Cloudflare Worker** that holds the Anthropic API key as a secret, forwards uploaded PDFs to the **Anthropic Messages API** as base64 `document` blocks (or via the Files API for reuse), streams the response back, and enforces rate limits. No appraisal file is ever written to disk on the server; documents live in the browser session and in-flight request only.

---

## 2. Why this over the alternatives

| Option | Verdict | Reason |
|---|---|---|
| **Cloudflare Workers + GitHub Pages** | **CHOSEN** | Edge latency, generous free tier, first-class secret storage, streaming support, trivial rate limiting, no cold-start tax. Frontend hosting is free and already Git-based. |
| Direct browser → Anthropic API | Rejected | Would expose the API key in client code. Non-starter for a financial tool. |
| Google Apps Script proxy | Rejected | 6-minute execution cap, clumsy streaming, slow cold starts, awkward binary/base64 handling for large PDFs. |
| Supabase Edge Functions | Viable, heavier | Fine, but pulls in a whole BaaS platform we don't need for a session-only tool. Reconsider only if we add auth + case management. |
| Firebase Functions | Rejected | Cold starts, heavier than needed, Google lock-in. |
| Vercel/Netlify Functions | Viable alt | Comparable to Workers; pick Workers for edge + cheaper streaming. Vercel is the fallback if the team already lives there. |

**Rule of thumb:** the moment we add real user accounts, saved cases, or audit history, revisit Supabase. Until then, Workers is the least infrastructure that does the job.

---

## 3. Request flow

```
Browser (GitHub Pages, React SPA)
  │  user uploads appraisal PDF + MLS comp PDFs (held in-memory, base64)
  │  POST /api/rov  { caseInfo, documents:[{tag, base64, name}], systemPrompt, userMessage }
  ▼
Cloudflare Worker  (holds ANTHROPIC_API_KEY as secret)
  │  validate size/pages, assemble Messages API request
  │  attach each PDF as a document block, add system + user text
  │  POST https://api.anthropic.com/v1/messages   (stream: true)
  ▼
Anthropic Messages API  (model: claude-sonnet-4-6 or better; PDF-native)
  │  reads appraisal + comps, extracts factors, computes indications, writes ROV
  ▼
Worker streams tokens back → Browser renders ROV live
```

Nothing is persisted server-side. The Worker is stateless.

---

## 4. Anthropic API specifics that constrain the design

Verified against current Anthropic docs (platform.claude.com/docs, Aug 2026):

- **PDF is native.** Send each PDF as a `document` block: `{ type: "document", source: { type: "base64", media_type: "application/pdf", data: "<b64>" } }`. Works for both text and visual content (grids, charts) — which is exactly what an appraisal is. No beta header required on current models.
- **Hard limits per PDF: 32 MB and 100 pages.** A full appraisal (30-50 pp) plus 4-5 MLS sheets can exceed 100 pages *combined*, so we send them as **separate document blocks in one request**, not a merged PDF. Each block is independently under the 100-page ceiling.
- **Request size ~40 MB max** once base64 inflates the payload (~33% overhead). Watch the total.
- **Files API (upload once, reference by `file_id`)** is the recommended path for anything reused across turns (e.g. the appraisal during Regenerate). Upload the appraisal once, get a `file_id`, reference it on every subsequent call — eliminates re-encoding and re-transfer.
- **Model:** `claude-sonnet-4-6` is the documented minimum for PDF work and matches the proof-of-concept prompt. Opus-class for hardest cases. Keep the model ID in Worker config so it's swappable.
- **max_tokens ≥ 8000** for the full ROV + internal notes (the proof-of-concept prompt is long-output).
- **Prompt caching** on the appraisal document + system prompt: 5-minute ephemeral cache, refreshed on use. Regenerate and per-section refresh become much cheaper.
- **Streaming** (`stream: true`) so the loan officer sees the ROV build in real time instead of waiting 30-60s.

---

## 5. Security & privacy (financial-document grade)

- **API key** lives only as a Cloudflare Worker secret (`wrangler secret put ANTHROPIC_API_KEY`). Never in the client bundle, never in Git.
- **Session-only by default.** Documents are never written to Worker storage (no KV, no R2) in v1. They exist in the browser tab and in the single in-flight request.
- **CORS** locked to the GitHub Pages origin only.
- **Rate limiting** in the Worker (e.g. 100 requests/hour/key or per-IP) to prevent key abuse and runaway spend.
- **No logging of document contents.** Log only request metadata (timestamp, size, status) — never the PDF bytes or extracted values. Set the Anthropic request to zero-data-retention posture where available.
- **Opt-in storage later.** If case management is added, that's an explicit, separate, encrypted feature (R2 + per-user auth) — not the default.
- **Transport:** HTTPS end to end (GitHub Pages and Workers are TLS by default).

---

## 6. Cost model (order of magnitude)

Per ROV run, the appraisal + comps are the token driver (PDFs are tokenized by page). A 40-page appraisal + five MLS sheets is a large-but-bounded input; output is ~8k tokens. Prompt caching the appraisal makes Regenerate and per-section refresh a fraction of the first call. Cloudflare Workers free tier (100k requests/day) comfortably covers a 2-10 person team; Anthropic API usage is the real cost line. Set a monthly spend cap in the Anthropic console and a per-key rate limit in the Worker.

---

## 7. What changes in the existing code

The React app barely changes. Today it calls `window.claude.complete(text)`. In production:

1. Replace that single call with `fetch("/api/rov", { method: "POST", body: JSON.stringify({...}) })` against the Worker, reading a streamed response.
2. The upload zones already hold `File` objects — add base64 encoding on submit (`FileReader.readAsDataURL`) and include them as tagged document blocks in the request body.
3. The system prompt and `buildUserMessage` move server-side into the Worker (so the prompt isn't visible in client code), or stay client-side and get passed through — decide based on whether the prompt is considered proprietary.
4. Everything else — the UI, evidence ledger, tags, editing, export, print — is unchanged.

---

## 8. Build order from here

1. **Scaffold the Worker** — `wrangler init`, health check, CORS, secret for the API key.
2. **Wire one real call** — appraisal PDF → document block → Messages API → streamed text back to the app. Replace `window.claude.complete`.
3. **Multi-document** — attach comps + prior appraisal as separate blocks; enforce per-PDF page/size checks client-side with clear errors.
4. **Files API + caching** — upload the appraisal once, reference by `file_id`, cache system prompt + appraisal for cheap Regenerate.
5. **OCR fallback** — detect image-only/scanned PDFs; the model reads most scans natively, but keep a server-side OCR path for poor scans.
6. **DOCX/PDF export** — server-side generation of a formatted submission document (beyond the current markdown/print view).
7. **Deploy** — GitHub Pages for the SPA, `wrangler deploy` for the Worker, lock CORS to the Pages origin, set spend caps.

---

## 9. Open questions to settle before coding the Worker

- Where does the system prompt live — server-side (hidden) or passed from client? (Recommend server-side.)
- Do we adopt the **Files API** from day one, or start with base64 and add it in step 4? (Recommend base64 first for simplicity, Files API once Regenerate matters.)
- Team size and expected volume → sets the rate limit and spend cap.
- Any requirement to keep an audit trail? If yes, that forces an opt-in storage decision earlier.
