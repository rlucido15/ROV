# Test Plan

Run these before real use. Grouped by area. Each row: what to do → what should
happen. Mark P/F. Where a test needs a bad input, keep a junk PDF and a
>100-page PDF handy.

Prereq: backend deployed (LAUNCH_CHECKLIST Part 2), web app running locally or on
Pages, Kuhio appraisal + 2–3 comp MLS PDFs available.

---

## A. Backend connectivity

| # | Do | Expect |
|---|---|---|
| A1 | GET the `/exec` URL in a browser | `{"ok":true,"service":"rov-appscript"}` |
| A2 | Run an analysis from the app | ROV returns in ~30–60s |
| A3 | Temporarily set `VITE_APP_TOKEN` wrong, run | App shows `Unauthorized.` |
| A4 | Restore token, run | Works again |

## B. Required-field gating

| # | Do | Expect |
|---|---|---|
| B1 | Click **Run** with all fields empty | Button triggers red "Required" on address, borrower, appraised value, target range, deal issues; no request sent |
| B2 | Fill case facts but no appraisal PDF | Run stays disabled; status reads "Add the appraisal report to begin." |
| B3 | Fill everything + appraisal | Run enabled |

## C. Evidence handling

| # | Do | Expect |
|---|---|---|
| C1 | Drop appraisal PDF | Appears as `APP-01` |
| C2 | Drop 3 comp PDFs | Appear as `CMP-01/02/03` |
| C3 | Drag a comp to reorder | Order changes; ledger priority follows |
| C4 | Add an address-only comp | Appears as `ADR-01`, orange "unverified" |
| C5 | Remove a comp | Tags renumber correctly |
| C6 | Drop a prior appraisal | Appears as `PRI-00` |
| C7 | Comp-count meter | Reads "n of 4–5 recommended"; hits "Target met" at 4 |

## D. Generation quality (the important one)

Run the full Kuhio case. In the output, verify:

| # | Check | Expect |
|---|---|---|
| D1 | Adjustment math | Uses the report's OWN factors ($/sf, $/acre, etc.), not invented |
| D2 | Comp triage | Primary comps gridded; land/context in narrative; weak excluded |
| D3 | GLA bracketing | Notes the report's comps fail to bracket 4,141 sf; alternatives fix it |
| D4 | Discrepancy | Raises the bedroom vs family-room reclassification as a reconciliation request |
| D5 | Internal inconsistencies | Surfaces Cost Approach / land-value / reconciliation-weight points if present |
| D6 | Summary table | "Summary of Adjusted Indications" table with range + central tendency |
| D7 | Tone | Respectful; no "error/erred/overlooked"; no accusation |
| D8 | Target value | The internal target range does NOT appear anywhere in the ROV body |
| D9 | 5-sale limit | No more than 5 alternative sales used |
| D10 | Internal notes | Separate "INTERNAL NOTES — DO NOT SUBMIT" section present, collapsible |
| D11 | `[VERIFY]` items | Any unfound fact is bracketed, not fabricated |

## E. Editing & export

| # | Do | Expect |
|---|---|---|
| E1 | Click **Edit**, change text, **Done** | Edits persist in the view |
| E2 | Click **Word** | `.docx` downloads; opens in Word with headings, real table, bold, orange `[VERIFY]` |
| E3 | Click **PDF** | Print view opens; tables render; disclaimer at bottom |
| E4 | Click **.md** | Markdown file downloads |
| E5 | Click **Copy** | ROV markdown on clipboard |
| E6 | Click **Regenerate** | New version replaces the current one |

## F. Limits & errors

| # | Do | Expect |
|---|---|---|
| F1 | Upload a >32MB PDF | Client blocks it: "over 32MB" |
| F2 | Upload a >100-page PDF, run | Graceful error mentioning 100-page limit (from upstream) |
| F3 | Upload a junk/non-PDF renamed .pdf | Upstream error surfaced, app not stuck |
| F4 | Exceed `RATE_LIMIT_PER_DAY` | "Daily limit reached" message |
| F5 | Kill network mid-run | Error shown; app recoverable (can retry) |

## G. Privacy / security

| # | Do | Expect |
|---|---|---|
| G1 | `git grep -i "sk-ant"` in the repo | No matches (key only in Script Properties) |
| G2 | View page source / bundle | No API key; no system prompt text |
| G3 | Close the tab after a run | With unsaved work, browser warns before leaving |
| G4 | Reopen the app | No prior appraisal or ROV persisted (session-only) |

## H. Theme / responsive

| # | Do | Expect |
|---|---|---|
| H1 | Toggle dark/light | All panels legible in both |
| H2 | Narrow the window / mobile | Layout stacks; no overflow |

---

## Sign-off

- [ ] A–C pass (plumbing + inputs)
- [ ] D passes (generation quality against Kuhio) — the real acceptance gate
- [ ] E–F pass (export + limits)
- [ ] G passes (no secrets leaked, session-only holds)

When D passes on the Kuhio file and a second real appraisal, it's launch-ready.
