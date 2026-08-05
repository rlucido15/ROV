import React, { useState, useRef, useCallback, useMemo, useEffect } from "react";
import {
  Upload, FileText, Sun, Moon, Copy, Download, ChevronDown, ChevronRight,
  Loader2, CheckCircle2, AlertTriangle, Search, ClipboardList, FileSignature,
  Plus, Trash2, ShieldCheck, Info, History, X, Home, Building2, MapPin,
  GripVertical, RefreshCw, Printer, Target,
} from "lucide-react";
import { runRov } from "./api.js";
import { exportDocx, exportPdf } from "./export.js";

const COMP_TARGET = 4;      // minimum recommended
const COMP_IDEAL = 5;       // ideal

/* ------------------------------------------------------------------ */
/*  Reconsideration of Value (ROV) Assistant — Phase 1 prototype       */
/*  Session-only. No storage. Analysis runs via the Cloudflare Worker (api.js). */
/* ------------------------------------------------------------------ */

const uid = () => Math.random().toString(36).slice(2, 9);

export default function App() {
  const [dark, setDark] = useState(true);
  const [appraisal, setAppraisal] = useState(null);      // { name, size }
  const [comps, setComps] = useState([]);                 // [{ id, name, size }]
  const [addressComps, setAddressComps] = useState([]);   // [{ id, address }]
  const [priorAppraisal, setPriorAppraisal] = useState(null);
  const [drag, setDrag] = useState(null);                 // which zone is drag-active
  const [addrInput, setAddrInput] = useState("");
  const [caseInfo, setCaseInfo] = useState({
    address: "", borrower: "", appraisedValue: "",
    loanNo: "", targetRange: "", specialIssues: "",
  });
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [status, setStatus] = useState("idle");
  const [progress, setProgress] = useState("");
  const [result, setResult] = useState(null);   // { rov, notes }
  const [showNotes, setShowNotes] = useState(false);
  const [editingRov, setEditingRov] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [manualDistances, setManualDistances] = useState({}); // { "CMP-01": "3.2" }
  const [needsManual, setNeedsManual] = useState([]);          // [{ tag, address }]
  const [errMsg, setErrMsg] = useState("");
  const [triedRun, setTriedRun] = useState(false);
  const [dragIdx, setDragIdx] = useState(null);

  const appraisalRef = useRef(null);
  const compRef = useRef(null);
  const priorRef = useRef(null);

  const t = useMemo(() => tokens(dark), [dark]);

  /* warn on tab close if any evidence or case facts have been entered */
  const hasWork =
    appraisal || comps.length || addressComps.length || priorAppraisal ||
    caseInfo.address || caseInfo.borrower || caseInfo.appraisedValue || caseInfo.targetRange || result;
  useEffect(() => {
    const handler = (e) => { if (hasWork) { e.preventDefault(); e.returnValue = ""; } };
    window.addEventListener("beforeunload", handler);
    return () => window.removeEventListener("beforeunload", handler);
  }, [hasWork]);

  /* ------- upload handlers (session-only, never stored) ------- */
  const dropHandlers = (zone, onFiles) => ({
    onDragOver: (e) => { e.preventDefault(); setDrag(zone); },
    onDragLeave: () => setDrag((z) => (z === zone ? null : z)),
    onDrop: (e) => { e.preventDefault(); setDrag(null); if (e.dataTransfer?.files?.length) onFiles(e.dataTransfer.files); },
  });

  const addAppraisal = (fl) => { const f = fl[0]; if (f) setAppraisal({ name: f.name, size: f.size, file: f }); };
  const addPrior = (fl) => { const f = fl[0]; if (f) setPriorAppraisal({ name: f.name, size: f.size, file: f }); };
  const addComps = (fl) =>
    setComps((c) => [...c, ...Array.from(fl).map((f) => ({ id: uid(), name: f.name, size: f.size, file: f }))]);

  const addAddress = () => {
    const v = addrInput.trim();
    if (!v) return;
    setAddressComps((a) => [...a, { id: uid(), address: v }]);
    setAddrInput("");
  };

  const compTag = (i) => `CMP-${String(i + 1).padStart(2, "0")}`;
  const addrTag = (i) => `ADR-${String(i + 1).padStart(2, "0")}`;

  /* drag-to-reorder comps */
  const onCompDragStart = (i) => setDragIdx(i);
  const onCompDragOver = (e, i) => {
    e.preventDefault();
    if (dragIdx === null || dragIdx === i) return;
    setComps((arr) => {
      const next = [...arr];
      const [moved] = next.splice(dragIdx, 1);
      next.splice(i, 0, moved);
      return next;
    });
    setDragIdx(i);
  };
  const onCompDragEnd = () => setDragIdx(null);

  /* ---------------------- run analysis ---------------------- */
  const buildLedger = () => [
    appraisal ? `APP-01  [appraisal]  ${appraisal.name}` : "",
    ...comps.map((c, i) => `${compTag(i)}  [mls comparable — priority ${i + 1}]  ${c.name}`),
    ...addressComps.map((a, i) => `${addrTag(i)}  [address-only comp — UNVERIFIED, MLS sheet needed]  ${a.address}`),
    priorAppraisal ? `PRI-00  [prior appraisal]  ${priorAppraisal.name}` : "",
  ].filter(Boolean).join("\n");

  // Pair each uploaded File with its ledger tag for the API.
  const buildFiles = () => [
    appraisal?.file ? { tag: "APP-01", file: appraisal.file } : null,
    ...comps.map((c, i) => (c.file ? { tag: compTag(i), file: c.file } : null)),
    priorAppraisal?.file ? { tag: "PRI-00", file: priorAppraisal.file } : null,
  ].filter(Boolean);

  // Shared streaming call. Streams markdown in and splits it live into { rov, notes }.
  const generate = async () => {
    const { needsManual: nm } = await runRov({
      caseInfo,
      files: buildFiles(),
      ledgerText: buildLedger(),
      manualDistances,
      onToken: (full) => {
        const { rov, notes } = splitRov(full);
        setResult({ rov, notes });
      },
    });
    setNeedsManual(nm || []);
  };

  const runAnalysis = async () => {
    setTriedRun(true);
    if (!canRun) {
      if (requiredAdvanced.some((k) => !caseInfo[k].trim())) setShowAdvanced(true);
      return;
    }
    setStatus("running"); setErrMsg(""); setResult(null); setShowNotes(false);
    setProgress("Uploading the appraisal and analyzing — this can take up to a minute…");
    try {
      await generate();
      setStatus("done");
    } catch (e) {
      setErrMsg(String(e?.message || e)); setStatus("error");
    }
  };

  const regenerate = async () => {
    setStatus("running"); setErrMsg("");
    setProgress("Regenerating the ROV…");
    try {
      await generate();
      setStatus("done");
    } catch (e) {
      setErrMsg(String(e?.message || e)); setStatus("error");
    }
  };

  const requiredAdvanced = [];
  const caseComplete =
    caseInfo.address.trim() && caseInfo.borrower.trim() &&
    caseInfo.appraisedValue.trim() && caseInfo.targetRange.trim() &&
    caseInfo.specialIssues.trim() &&
    requiredAdvanced.every((k) => caseInfo[k].trim());
  const canRun = appraisal && caseComplete && status !== "running";
  const evidenceCount = (appraisal ? 1 : 0) + comps.length + addressComps.length + (priorAppraisal ? 1 : 0);

  return (
    <div style={{ ...t.page, minHeight: "100vh", fontFamily: t.sans }}>
      <style>{globalCss(t)}</style>

      <header style={t.header}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <img
            src={`${import.meta.env.BASE_URL}moxie-logo.png`}
            alt="Moxie"
            style={t.logo}
            onError={(e) => { e.currentTarget.style.display = "none"; }}
          />
          <div style={{ fontWeight: 700, letterSpacing: "-0.01em", fontSize: 15 }}>
            Reconsideration of Value Assistant
          </div>
        </div>
        <button style={t.iconBtn} onClick={() => setDark((v) => !v)} aria-label="Toggle theme">
          {dark ? <Sun size={16} /> : <Moon size={16} />}
        </button>
      </header>

      <div style={t.shell}>
        {/* ============ PRIMARY: CASE FACTS ============ */}
        <section style={t.heroCard}>
          <div style={t.heroHeadRow}>
            <div style={{ display: "flex", alignItems: "center", gap: 13 }}>
              <span style={t.heroIcon}><Home size={20} /></span>
              <div>
                <div style={t.heroTitle}>Case facts</div>
                <div style={t.heroSub}>The subject property and the value under reconsideration.</div>
              </div>
            </div>
          </div>

          {/* Property tier */}
          <div style={t.factGroup}>
            <div style={t.factGroupLabel}>Property</div>
            <div style={t.heroGrid}>
              <Field label="Subject address" required mono val={caseInfo.address}
                invalid={triedRun && !caseInfo.address.trim()}
                on={(v) => setCaseInfo((c) => ({ ...c, address: v }))} t={t} />
              <Field label="Borrower" required val={caseInfo.borrower}
                invalid={triedRun && !caseInfo.borrower.trim()}
                on={(v) => setCaseInfo((c) => ({ ...c, borrower: v }))} t={t} />
            </div>
          </div>

          {/* Valuation tier */}
          <div style={t.factGroup}>
            <div style={t.factGroupLabel}>Valuation</div>
            <div style={t.valuationRow}>
              <div style={t.valBox}>
                <span style={t.valLabel}>Appraised value <span style={{ color: t.accent2 }}>*</span></span>
                <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                  <span style={t.valPrefix}>$</span>
                  <input value={caseInfo.appraisedValue}
                    onChange={(e) => setCaseInfo((c) => ({ ...c, appraisedValue: fmtMoney(e.target.value) }))}
                    placeholder="0"
                    style={{ ...t.valInput, ...(triedRun && !caseInfo.appraisedValue.trim() ? t.valInvalid : null) }} />
                </div>
                <span style={t.valHint}>The report's opinion of value</span>
              </div>

              <div style={t.valArrow}>→</div>

              <div style={{ ...t.valBox, ...t.valBoxTarget, ...(triedRun && !caseInfo.targetRange.trim() ? { borderColor: "#e5484d" } : null) }}>
                <div style={{ display: "flex", alignItems: "center", gap: 6 }}>
                  <span style={t.valLabelTarget}>Target value range <span>*</span></span>
                  <span style={t.internalChip}>internal only</span>
                </div>
                <input value={caseInfo.targetRange}
                  onChange={(e) => setCaseInfo((c) => ({ ...c, targetRange: e.target.value }))}
                  placeholder="e.g. $4.3M–$4.6M"
                  style={{ ...t.valInput, color: t.accent2, padding: "2px 0" }} />
                <span style={{ ...t.valHint, color: t.accent2 }}>Never printed in the ROV — calibration only</span>
              </div>
            </div>
          </div>

          {/* Deal issues */}
          <div style={t.factGroup}>
            <div style={t.factGroupLabel}>Deal-specific issues to raise <span style={{ color: t.accent2 }}>*</span></div>
            <textarea
              value={caseInfo.specialIssues}
              onChange={(e) => setCaseInfo((c) => ({ ...c, specialIssues: e.target.value }))}
              placeholder="One issue per line. E.g. room classified as a bedroom in the prior appraisal now shown as a family room; renovation completed after the prior sale; low prior sale was a quick/distress sale. For each: what the borrower/LO asserts and what evidence supports it."
              style={{ ...t.advTextarea, minHeight: 96, ...(triedRun && !caseInfo.specialIssues.trim() ? { borderColor: "#e5484d", background: t.invalidBg } : null) }} />
            {triedRun && !caseInfo.specialIssues.trim() && <span style={t.invalidMsg}>Required</span>}
          </div>

          <button style={t.advToggle} onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Advanced Details
            <span style={t.advHint}>Loan number (optional)</span>
          </button>

          {showAdvanced && (
            <div style={t.advWrap}>
              <div style={t.advGrid}>
                <Field label="Loan no." mono val={caseInfo.loanNo} invalid={triedRun && !caseInfo.loanNo.trim()} on={(v) => setCaseInfo((c) => ({ ...c, loanNo: v }))} t={t} />
              </div>
            </div>
          )}
        </section>

        {/* ============ SECONDARY: EVIDENCE BENTO ============ */}
        <section style={t.evidenceWrap}>
          <div style={t.secHeadRow}>
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <span style={t.secKicker}>Evidence</span>
              <span style={{ fontSize: 12.5, color: t.muted }}>Documents that support the higher value</span>
            </div>
            <span style={t.countPill}>{evidenceCount} item{evidenceCount === 1 ? "" : "s"}</span>
          </div>

          <div style={t.bento}>
            {/* -- Appraisal (required, spans full height left) -- */}
            <div style={{ ...t.bentoCell, ...t.bentoAppraisal }}>
              <CellHead icon={FileText} title="Appraisal report" tag="APP-01"
                required badge={appraisal ? "loaded" : "required"} t={t} tone="accent" />
              {!appraisal ? (
                <DropZone t={t} tone="accent" active={drag === "appraisal"}
                  {...dropHandlers("appraisal", addAppraisal)}
                  onClick={() => appraisalRef.current?.click()}
                  title="Drop the appraisal PDF" sub="The report you're requesting reconsideration of" />
              ) : (
                <FileChip t={t} tone="accent" tag="APP-01" name={appraisal.name}
                  onRemove={() => setAppraisal(null)} />
              )}
              <input ref={appraisalRef} type="file" accept=".pdf" hidden
                onChange={(e) => e.target.files && addAppraisal(e.target.files)} />
              <div style={t.cellHint}>Auto-extraction of the grid, adjustments, and opinion of value comes in a later phase.</div>
            </div>

            {/* -- Comparable sales (MLS primary + address fallback) -- */}
            <div style={{ ...t.bentoCell, ...t.bentoComps }}>
              <CellHead icon={Building2} title="Comparable sales" tag="CMP"
                badge={comps.length ? `${comps.length} MLS` : "MLS sheets"} t={t} tone="accent" />

              <CompTarget t={t} count={comps.length} />

              <DropZone t={t} tone="accent" compact active={drag === "comps"}
                {...dropHandlers("comps", addComps)}
                onClick={() => compRef.current?.click()}
                title="Drop MLS listing PDFs" sub="Primary evidence — full data, citable" />
              <input ref={compRef} type="file" accept=".pdf" multiple hidden
                onChange={(e) => e.target.files && addComps(e.target.files)} />

              {comps.length > 0 && (
                <div style={t.chipList}>
                  {comps.length > 1 && (
                    <div style={t.reorderHint}>Drag to rank — top comp leads the ROV letter</div>
                  )}
                  {comps.map((c, i) => (
                    <div key={c.id}
                      draggable
                      onDragStart={() => onCompDragStart(i)}
                      onDragOver={(e) => onCompDragOver(e, i)}
                      onDragEnd={onCompDragEnd}
                      style={{ ...t.fileChip, border: `1px solid ${t.accent}44`, background: t.accentSoft,
                        opacity: dragIdx === i ? 0.5 : 1, cursor: "grab" }}>
                      <GripVertical size={13} style={{ color: t.muted, flexShrink: 0 }} />
                      <span style={{ ...t.chipTag }}>{compTag(i)}</span>
                      <FileText size={13} style={{ color: t.muted, flexShrink: 0 }} />
                      <span style={t.chipName} title={c.name}>{c.name}</span>
                      <button style={t.chipX} onClick={() => setComps((x) => x.filter((y) => y.id !== c.id))} aria-label="Remove"><X size={12} /></button>
                    </div>
                  ))}
                </div>
              )}

              {/* address fallback */}
              <div style={t.addrRow}>
                <MapPin size={13} style={{ color: t.accent2, flexShrink: 0 }} />
                <input
                  value={addrInput}
                  onChange={(e) => setAddrInput(e.target.value)}
                  onKeyDown={(e) => e.key === "Enter" && addAddress()}
                  placeholder="…or paste an address (needs MLS sheet later)"
                  style={t.addrInput}
                />
                <button style={t.addrBtn} onClick={addAddress} aria-label="Add address"><Plus size={14} /></button>
              </div>
              {addressComps.length > 0 && (
                <div style={t.chipList}>
                  {addressComps.map((a, i) => (
                    <div key={a.id} style={{ ...t.fileChip, ...t.fileChipWarn }}>
                      <span style={{ ...t.chipTag, ...t.chipTagWarn }}>{addrTag(i)}</span>
                      <span style={t.chipName} title={a.address}>{a.address}</span>
                      <span style={t.unverified}>unverified</span>
                      <button style={t.chipX} onClick={() => setAddressComps((x) => x.filter((y) => y.id !== a.id))}>
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>

            {/* -- Prior appraisal (optional) -- */}
            <div style={{ ...t.bentoCell, ...t.bentoPrior }}>
              <CellHead icon={History} title="Prior appraisal" tag="PRI-00"
                badge="optional" t={t} tone="accent2" />
              {!priorAppraisal ? (
                <DropZone t={t} tone="accent2" compact active={drag === "prior"}
                  {...dropHandlers("prior", addPrior)}
                  onClick={() => priorRef.current?.click()}
                  title="Drop an earlier appraisal" sub="Shows the value trend over time" />
              ) : (
                <FileChip t={t} tone="accent2" tag="PRI-00" name={priorAppraisal.name}
                  onRemove={() => setPriorAppraisal(null)} />
              )}
              <input ref={priorRef} type="file" accept=".pdf" hidden
                onChange={(e) => e.target.files && addPrior(e.target.files)} />
            </div>
          </div>

          <div style={t.evidenceFooter}>
            <div style={t.privacyNote}>
              <ShieldCheck size={13} style={{ flexShrink: 0, color: t.accent }} />
              <span>Files stay in your browser session and clear when you close the tab. Nothing is stored on a server in this prototype.</span>
            </div>
            <div style={t.runGroup}>
              <div style={{ display: "flex", alignItems: "center", gap: 8, textAlign: "right" }}>
                <span style={{ ...t.statusDot, background: canRun ? t.accent : t.border }} />
                <span style={{ fontSize: 12, color: t.muted }}>
                  {!appraisal ? "Add the appraisal report to begin."
                    : !caseComplete ? "Complete all case facts to begin."
                    : status === "running" ? progress
                    : "Ready to analyze."}
                </span>
              </div>
              <button style={{ ...t.runBtn, ...(canRun ? null : t.runBtnDisabled) }}
                disabled={status === "running"} onClick={runAnalysis}>
                {status === "running" ? <><Loader2 size={15} className="spin" /> Analyzing…</> : <><Search size={15} /> Run analysis</>}
              </button>
            </div>
          </div>
        </section>

        {status === "error" && (
          <div style={t.errorBox}>
            <AlertTriangle size={15} style={{ flexShrink: 0 }} />
            <span>Analysis didn't complete: {errMsg} — adjust inputs and run again.</span>
          </div>
        )}

        {/* ============ RESULTS ============ */}
        {result && (
          <>
            <div style={t.resultsHead}>
              <span style={t.heroTitle}>ROV document</span>
              <div style={{ display: "flex", gap: 8 }}>
                <button style={t.ghostBtn} onClick={regenerate} disabled={status === "running"}>
                  {status === "running" ? <><Loader2 size={13} className="spin" /> Regenerating…</> : <><RefreshCw size={13} /> Regenerate</>}
                </button>
                <button style={t.ghostBtn} onClick={() => setEditingRov((v) => !v)}>
                  {editingRov ? "Done editing" : "Edit"}
                </button>
                <button style={t.ghostBtn} onClick={() => navigator.clipboard?.writeText(result.rov)}><Copy size={13} /> Copy</button>
                <button style={t.ghostBtn} onClick={() => { setExporting(true); exportDocx(result.rov, caseInfo).catch((e) => setErrMsg(String(e?.message || e))).finally(() => setExporting(false)); }} disabled={exporting}>
                  {exporting ? <><Loader2 size={13} className="spin" /> Building…</> : <><FileText size={13} /> Word</>}
                </button>
                <button style={t.ghostBtn} onClick={() => exportPdf(result.rov, caseInfo)}><Printer size={13} /> PDF</button>
                <button style={t.ghostBtn} onClick={() => downloadRov(result, caseInfo)}><Download size={13} /> .md</button>
              </div>
            </div>

            <ConfidenceHeader t={t}
              comps={comps.length} addrs={addressComps.length}
              hasPrior={!!priorAppraisal} target={caseInfo.targetRange} />

            {needsManual.length > 0 && (
              <div style={t.manualPanel}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <MapPin size={14} style={{ color: t.accent2 }} />
                  <span style={{ fontWeight: 700, fontSize: 13 }}>Distances need confirmation</span>
                </div>
                <div style={{ fontSize: 12, color: t.muted, marginBottom: 10, lineHeight: 1.5 }}>
                  These comps couldn't be geocoded to a precise address. Enter the straight-line distance from the subject (miles, e.g. 3.2) and recompute — the report will use your figures.
                </div>
                {needsManual.map((nm) => (
                  <div key={nm.tag} style={t.manualRow}>
                    <span style={t.chipTag}>{nm.tag}</span>
                    <span style={{ flex: 1, fontSize: 12, color: t.text, minWidth: 0, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={nm.address}>{nm.address || "(address not found)"}</span>
                    <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
                      <input
                        value={manualDistances[nm.tag] || ""}
                        onChange={(e) => setManualDistances((m) => ({ ...m, [nm.tag]: e.target.value.replace(/[^0-9.]/g, "") }))}
                        placeholder="0.0"
                        style={t.manualInput} />
                      <span style={t.manualUnit}>mi</span>
                    </div>
                  </div>
                ))}
                <button style={{ ...t.runBtn, marginTop: 10 }} disabled={status === "running"}
                  onClick={regenerate}>
                  {status === "running" ? <><Loader2 size={14} className="spin" /> Recomputing…</> : <><RefreshCw size={14} /> Recompute with distances</>}
                </button>
              </div>
            )}

            <div style={t.rovDoc}>
              {editingRov ? (
                <textarea value={result.rov} onChange={(e) => setResult((r) => ({ ...r, rov: e.target.value }))}
                  style={{ ...t.textarea, minHeight: 520 }} />
              ) : (
                <div className="rov-print-section">{renderMarkdown(result.rov, t)}</div>
              )}
            </div>

            {result.notes && (
              <div style={t.notesCard}>
                <button style={t.notesHead} onClick={() => setShowNotes((v) => !v)}>
                  <span style={{ display: "flex", alignItems: "center", gap: 9 }}>
                    <span style={t.notesIcon}><AlertTriangle size={13} /></span>
                    <span style={{ fontWeight: 700, fontSize: 13.5 }}>Internal notes — do not submit</span>
                    <span style={t.notesTag}>staff only</span>
                  </span>
                  {showNotes ? <ChevronDown size={16} /> : <ChevronRight size={16} />}
                </button>
                {showNotes && <div style={t.notesBody}>{renderMarkdown(result.notes, t)}</div>}
              </div>
            )}

            <div style={t.disclaimerRow}>
              Not an appraisal or a USPAP determination. Verify every figure against source documents before submission.
            </div>
          </>
        )}

        {!result && status !== "running" && (
          <div style={t.placeholder}>
            <div style={t.placeholderIcon}><FileSignature size={22} /></div>
            <div style={{ fontWeight: 650, fontSize: 15 }}>Your ROV document appears here</div>
            <div style={{ fontSize: 13, color: t.muted, maxWidth: 460, textAlign: "center", lineHeight: 1.5 }}>
              A complete, submission-ready Reconsideration of Value request — built from the appraisal's own adjustment factors — plus a separate internal-notes section for your eyes only.
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

/* ------------------------------- pieces -------------------------------- */

function CellHead({ icon: Icon, title, tag, badge, required, t, tone }) {
  const isWarn = badge === "required" || badge === "optional";
  const badgeStyle = tone === "accent2"
    ? { color: t.accent2, background: t.accent2Soft }
    : badge === "required"
    ? { color: t.accent2, background: t.accent2Soft }
    : { color: t.accent, background: t.accentSoft };
  return (
    <div style={t.cellHead}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span style={{ ...t.cellIcon, ...(tone === "accent2" ? t.cellIcon2 : null) }}><Icon size={14} /></span>
        <span style={{ fontWeight: 650, fontSize: 13.5 }}>{title}</span>
        <span style={{ ...t.cellTag, ...(tone === "accent2" ? t.cellTag2 : null) }}>{tag}</span>
      </div>
      <span style={{ ...t.cellBadge, ...badgeStyle }}>{badge}</span>
    </div>
  );
}

function DropZone({ t, tone, active, compact, title, sub, onClick, onDragOver, onDragLeave, onDrop }) {
  const toneStyle = tone === "accent2"
    ? (active ? t.dzActive2 : null)
    : (active ? t.dzActive : null);
  return (
    <div onClick={onClick} onDragOver={onDragOver} onDragLeave={onDragLeave} onDrop={onDrop}
      style={{ ...t.dz, ...(compact ? t.dzCompact : null), ...toneStyle }}>
      <span style={{ ...t.dzIcon, ...(tone === "accent2" ? t.dzIcon2 : null) }}><Upload size={compact ? 14 : 17} /></span>
      <div style={{ fontWeight: 600, fontSize: compact ? 12 : 13 }}>{title}</div>
      <div style={{ fontSize: 11, color: t.muted, lineHeight: 1.4 }}>{sub}</div>
    </div>
  );
}

function FileChip({ t, tone, tag, name, onRemove, small }) {
  const s = tone === "accent2"
    ? { border: `1px solid ${t.accent2}55`, background: t.accent2Soft }
    : { border: `1px solid ${t.accent}44`, background: t.accentSoft };
  const tagS = tone === "accent2" ? t.chipTag2 : t.chipTag;
  return (
    <div style={{ ...t.fileChip, ...s, ...(small ? { padding: "7px 9px" } : null) }}>
      <span style={{ ...t.chipTag, ...tagS }}>{tag}</span>
      <FileText size={13} style={{ color: t.muted, flexShrink: 0 }} />
      <span style={t.chipName} title={name}>{name}</span>
      <button style={t.chipX} onClick={onRemove} aria-label="Remove"><X size={12} /></button>
    </div>
  );
}

function Field({ label, val, on, t, required, mono, prefix, invalid }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={t.fieldLabel}>
        {label}{required && <span style={{ color: t.accent2 }}> *</span>}
      </span>
      <div style={{ position: "relative", display: "flex", alignItems: "center" }}>
        {prefix && <span style={t.inputPrefix}>{prefix}</span>}
        <input value={val} onChange={(e) => on(e.target.value)}
          style={{ ...t.input, fontFamily: mono ? t.mono : t.sans, paddingLeft: prefix ? 24 : 12,
            ...(invalid ? { borderColor: "#e5484d", background: t.invalidBg } : null) }} />
      </div>
      {invalid && <span style={t.invalidMsg}>Required</span>}
    </label>
  );
}

function CompTarget({ t, count }) {
  const pct = Math.min(count / COMP_IDEAL, 1) * 100;
  const met = count >= COMP_TARGET;
  const ideal = count >= COMP_IDEAL;
  const label = ideal ? "Ideal — 5 comps"
    : met ? `Target met — ${count} of ${COMP_IDEAL} ideal`
    : `${count} of ${COMP_TARGET}–${COMP_IDEAL} recommended`;
  return (
    <div style={t.compTarget}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 5 }}>
        <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 11, color: t.muted }}>
          <Target size={12} style={{ color: met ? t.accent : t.muted }} />
          {label}
        </span>
        {met && <CheckCircle2 size={13} style={{ color: t.accent }} />}
      </div>
      <div style={t.meterTrack}>
        <div style={{ ...t.meterFill, width: `${pct}%`,
          background: met ? t.accent : `linear-gradient(90deg, ${t.accent}, ${t.accent2})` }} />
      </div>
    </div>
  );
}

function ConfidenceHeader({ t, comps, addrs, hasPrior, target }) {
  const cited = comps + (hasPrior ? 1 : 0) + 1; // + appraisal
  const strong = comps >= COMP_TARGET;
  const items = [
    { label: "Cited evidence items", value: cited, tone: "accent" },
    { label: "MLS comps", value: comps, tone: strong ? "accent" : "warn" },
    { label: "Unverified addresses", value: addrs, tone: addrs ? "warn" : "muted" },
    { label: "Prior appraisal", value: hasPrior ? "Yes" : "No", tone: hasPrior ? "accent" : "muted" },
  ];
  return (
    <div style={t.confHeader}>
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <span style={{ ...t.confBadge, background: strong ? t.accentSoft : t.accent2Soft,
          color: strong ? t.accent : t.accent2 }}>
          {strong ? "Well-supported" : "Needs more comps"}
        </span>
        {target && target.trim() && <span style={{ fontSize: 12, color: t.muted }}>Target <b style={{ color: t.accent2, fontFamily: t.mono }}>{target}</b> · internal only</span>}
      </div>
      <div style={t.confStats}>
        {items.map((it) => (
          <div key={it.label} style={t.confStat}>
            <span style={{ fontFamily: t.mono, fontWeight: 800, fontSize: 16,
              color: it.tone === "accent" ? t.accent : it.tone === "warn" ? t.accent2 : t.muted }}>
              {it.value}
            </span>
            <span style={{ fontSize: 10.5, color: t.muted }}>{it.label}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

function TextArea({ label, val, on, t, placeholder, required, invalid }) {
  return (
    <label style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <span style={t.fieldLabel}>{label}{required && <span style={{ color: t.accent2 }}> *</span>}</span>
      <textarea value={val} onChange={(e) => on(e.target.value)} placeholder={placeholder}
        style={{ ...t.advTextarea, ...(invalid ? { borderColor: "#e5484d", background: t.invalidBg } : null) }} />
      {invalid && <span style={t.invalidMsg}>Required</span>}
    </label>
  );
}

/* very small markdown renderer: headings, bold, tables, hr, lists, paragraphs */
function renderMarkdown(md, t) {
  if (!md) return <span style={{ color: t.muted }}>No content.</span>;
  const lines = md.replace(/\r/g, "").split("\n");
  const out = [];
  let i = 0, key = 0;
  const inline = (s) =>
    s.split(/(\*\*[^*]+\*\*|\[[^\]]*\]|\bAPP-\d{2}\b|\bCMP-\d{2}\b|\bADR-\d{2}\b|\bPRI-\d{2}\b|\[VERIFY[^\]]*\])/g)
      .map((p, j) => {
        if (/^\*\*[^*]+\*\*$/.test(p)) return <strong key={j}>{p.slice(2, -2)}</strong>;
        if (/^\[VERIFY/i.test(p)) return <span key={j} style={t.verifyTag}>{p}</span>;
        if (/^(APP|CMP|ADR|PRI)-\d{2}$/.test(p)) return <span key={j} style={t.inlineTag}>{p}</span>;
        return <span key={j}>{p}</span>;
      });

  while (i < lines.length) {
    const line = lines[i];
    if (/^\s*$/.test(line)) { i++; continue; }
    if (/^---+$/.test(line.trim())) { out.push(<hr key={key++} style={t.mdHr} />); i++; continue; }
    // table block
    if (line.includes("|") && lines[i + 1] && /^\s*\|?[\s:|-]+\|?\s*$/.test(lines[i + 1])) {
      const header = line.split("|").map((c) => c.trim()).filter(Boolean);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes("|")) {
        rows.push(lines[i].split("|").map((c) => c.trim()).filter((_, idx, arr) => !(idx === 0 && arr[0] === "") ));
        i++;
      }
      out.push(
        <div key={key++} style={{ overflowX: "auto" }}>
          <table style={t.mdTable}>
            <thead><tr>{header.map((h, hi) => <th key={hi} style={t.mdTh}>{inline(h)}</th>)}</tr></thead>
            <tbody>{rows.map((r, ri) => (
              <tr key={ri}>{r.map((cell, ci) => <td key={ci} style={t.mdTd}>{inline(cell.trim())}</td>)}</tr>
            ))}</tbody>
          </table>
        </div>
      );
      continue;
    }
    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const lvl = h[1].length;
      const sz = [21, 17, 15, 13.5][lvl - 1];
      out.push(<div key={key++} style={{ ...t.mdH, fontSize: sz, marginTop: lvl <= 2 ? 22 : 16 }}>{inline(h[2])}</div>);
      i++; continue;
    }
    if (/^\s*[-*]\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*[-*]\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*[-*]\s+/, "")); i++;
      }
      out.push(<ul key={key++} style={t.mdUl}>{items.map((it, ii) => <li key={ii} style={{ marginBottom: 4 }}>{inline(it)}</li>)}</ul>);
      continue;
    }
    if (/^\s*\d+\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^\s*\d+\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^\s*\d+\.\s+/, "")); i++;
      }
      out.push(<ol key={key++} style={t.mdOl}>{items.map((it, ii) => <li key={ii} style={{ marginBottom: 4 }}>{inline(it)}</li>)}</ol>);
      continue;
    }
    out.push(<p key={key++} style={t.mdP}>{inline(line)}</p>);
    i++;
  }
  return <div>{out}</div>;
}

function fmtMoney(v) {
  const digits = String(v).replace(/[^0-9]/g, "");
  if (!digits) return "";
  return Number(digits).toLocaleString("en-US");
}

/* The ROV system prompt + user-message builder live server-side in the
   Cloudflare Worker (worker/src/prompt.js) so they stay out of the client bundle. */


function splitRov(raw) {
  let s = (raw || "").trim().replace(/^\`\`\`(markdown|md)?/i, "").replace(/\`\`\`$/, "").trim();
  // find the internal notes divider
  const m = s.match(/\n-{3,}\s*\n\s*#{0,4}\s*INTERNAL NOTES[^\n]*\n/i);
  if (m) {
    const idx = m.index;
    const rov = s.slice(0, idx).trim();
    const notes = s.slice(idx).replace(/^\n-{3,}\s*\n/, "").trim();
    return { rov, notes };
  }
  // fallback: split on a heading containing INTERNAL NOTES
  const alt = s.search(/#{1,4}\s*INTERNAL NOTES/i);
  if (alt !== -1) return { rov: s.slice(0, alt).trim(), notes: s.slice(alt).trim() };
  return { rov: s, notes: "" };
}

function downloadRov(result, info) {
  const blob = new Blob([result.rov], { type: "text/markdown" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url; a.download = "reconsideration-of-value.md"; a.click();
  URL.revokeObjectURL(url);
}



/* ------------------------------- theme --------------------------------- */

function tokens(dark) {
  const accent = "#28b5cf";
  const accent2 = "#F46744";
  const c = dark
    ? { bg: "#0b1016", header: "#111820", headerText: "#e8eef4", headerBorder: "#232f3d",
        panel: "#eef1f5", panel2: "#e2e7ee", border: "#cdd5df",
        text: "#141b24", muted: "#556072", accentSoft: "#d6eef4", accent2Soft: "#fce2db",
        dot: "rgba(255,255,255,0.06)" }
    : { bg: "#f4f7fa", header: "#ffffff", headerText: "#0f1720", headerBorder: "#dce3ec",
        panel: "#ffffff", panel2: "#eef2f7", border: "#dce3ec",
        text: "#0f1720", muted: "#5a6878", accentSoft: "#e2f5f9", accent2Soft: "#fdece7",
        dot: "rgba(15,23,32,0.06)" };
  const sans = "Inter, system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
  const mono = "'JetBrains Mono', 'SF Mono', ui-monospace, Menlo, monospace";
  const chipTag = {
    fontFamily: mono, fontSize: 10, fontWeight: 700, color: accent,
    background: c.accentSoft, borderRadius: 5, padding: "2px 6px", flexShrink: 0, letterSpacing: "0.02em",
  };
  return {
    ...c, accent, accent2, sans, mono, chipTag,
    page: {
      background: c.bg,
      backgroundImage: `radial-gradient(${c.dot} 1px, transparent 1px)`,
      backgroundSize: "22px 22px",
      backgroundPosition: "-1px -1px",
      color: c.text,
    },
    header: {
      display: "flex", justifyContent: "space-between", alignItems: "center",
      padding: "14px 24px", borderBottom: `1px solid ${c.headerBorder}`,
      background: c.header, color: c.headerText, position: "sticky", top: 0, zIndex: 10, backdropFilter: "blur(8px)",
    },
    mark: {
      fontFamily: mono, fontWeight: 800, fontSize: 15, letterSpacing: "0.04em",
      color: "#fff", borderRadius: 8, padding: "7px 10px",
      background: `linear-gradient(135deg, ${accent}, ${accent2})`,
    },
    logo: { height: 32, width: "auto", display: "block", objectFit: "contain" },
    iconBtn: {
      background: "transparent", border: `1px solid ${c.headerBorder}`, color: c.headerText,
      borderRadius: 9, width: 36, height: 36, cursor: "pointer", display: "grid", placeItems: "center",
    },
    shell: { display: "flex", flexDirection: "column", gap: 16, maxWidth: 1080, margin: "0 auto", padding: 22 },

    /* hero / case facts */
    heroCard: {
      background: c.panel, border: `1px solid ${c.border}`, borderRadius: 16, padding: 24,
      boxShadow: dark ? "0 6px 24px rgba(0,0,0,0.35)" : "0 4px 20px rgba(15,23,32,0.05)",
      borderTop: `2px solid ${accent}`,
    },
    heroHeadRow: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 16, marginBottom: 20 },
    heroIcon: {
      width: 42, height: 42, borderRadius: 12, display: "grid", placeItems: "center", color: "#fff",
      background: `linear-gradient(135deg, ${accent}, ${accent2})`,
    },
    heroTitle: { fontWeight: 750, fontSize: 20, letterSpacing: "-0.02em" },
    heroSub: { fontSize: 13, color: c.muted, marginTop: 3, lineHeight: 1.45 },
    gapPill: {
      display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 2,
      border: `1px solid ${accent2}44`, background: c.accent2Soft, borderRadius: 12, padding: "10px 16px", flexShrink: 0,
    },
    heroGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16 },
    factGroup: { marginTop: 18 },
    factGroupLabel: { fontSize: 11, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: c.muted, marginBottom: 10, paddingBottom: 7, borderBottom: `1px solid ${c.border}` },
    valuationRow: { display: "flex", alignItems: "stretch", gap: 14 },
    valBox: { flex: 1, display: "flex", flexDirection: "column", gap: 5, background: c.panel2, border: `1px solid ${c.border}`, borderRadius: 12, padding: "13px 16px" },
    valBoxTarget: { background: c.accent2Soft, border: `1px solid ${accent2}55` },
    valLabel: { fontSize: 11.5, color: c.muted, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" },
    valLabelTarget: { fontSize: 11.5, color: accent2, fontWeight: 700, letterSpacing: "0.02em", textTransform: "uppercase" },
    valPrefix: { position: "absolute", left: 0, color: c.muted, fontFamily: mono, fontSize: 22, fontWeight: 700, pointerEvents: "none" },
    valInput: { width: "100%", border: "none", background: "transparent", color: c.text, fontFamily: mono, fontSize: 22, fontWeight: 700, letterSpacing: "-0.01em", padding: "2px 0 2px 18px", boxSizing: "border-box", outline: "none" },
    valInvalid: { color: "#e5484d" },
    valHint: { fontSize: 10.5, color: c.muted },
    valArrow: { display: "flex", alignItems: "center", color: c.muted, fontSize: 20, fontWeight: 300, flexShrink: 0 },
    internalNote: { display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: c.muted, marginTop: 10, fontStyle: "italic" },
    fieldLabel: { fontSize: 11.5, color: c.muted, fontWeight: 600, letterSpacing: "0.02em", textTransform: "uppercase" },
    input: {
      padding: "11px 12px", borderRadius: 10, border: `1px solid ${c.border}`,
      background: c.panel2, color: c.text, fontSize: 14, width: "100%", boxSizing: "border-box",
    },
    inputPrefix: { position: "absolute", left: 12, color: c.muted, fontFamily: mono, fontSize: 14, pointerEvents: "none" },
    invalidBg: dark ? "#f7dede" : "#fff2f2",
    invalidMsg: { fontSize: 10.5, color: "#e5484d", fontWeight: 600 },
    compTarget: { background: c.panel, border: `1px solid ${c.border}`, borderRadius: 9, padding: "8px 10px" },
    meterTrack: { height: 5, borderRadius: 3, background: c.border, overflow: "hidden" },
    meterFill: { height: "100%", borderRadius: 3, transition: "width .3s ease" },
    reorderHint: { fontSize: 10, color: c.muted, fontStyle: "italic", paddingLeft: 2 },
    confHeader: {
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap",
      background: c.panel, border: `1px solid ${c.border}`, borderRadius: 12, padding: "12px 16px",
      borderLeft: `3px solid ${accent}`,
    },
    confBadge: { fontSize: 11, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.04em", borderRadius: 6, padding: "4px 10px" },
    confStats: { display: "flex", gap: 20 },
    confStat: { display: "flex", flexDirection: "column", alignItems: "flex-end", gap: 1 },

    /* evidence bento */
    evidenceWrap: {
      background: c.panel, border: `1px solid ${c.border}`, borderRadius: 16, padding: 20,
    },
    secHeadRow: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 14 },
    secKicker: {
      fontSize: 12, fontWeight: 800, textTransform: "uppercase", letterSpacing: "0.08em",
      color: accent, background: c.accentSoft, borderRadius: 6, padding: "3px 9px",
    },
    countPill: {
      fontFamily: mono, fontSize: 11, fontWeight: 700, color: c.muted,
      background: c.panel2, border: `1px solid ${c.border}`, borderRadius: 20, padding: "3px 11px",
    },
    bento: { display: "grid", gridTemplateColumns: "1fr 1.35fr", gap: 12, alignItems: "start" },
    bentoCell: { background: c.panel2, border: `1px solid ${c.border}`, borderRadius: 13, padding: 14, display: "flex", flexDirection: "column", gap: 10 },
    bentoAppraisal: { gridColumn: "1", gridRow: "1" },
    bentoComps: { gridColumn: "2", gridRow: "1 / 3" },
    bentoPrior: { gridColumn: "1", gridRow: "2" },

    cellHead: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 8 },
    cellIcon: { width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", background: c.accentSoft, color: accent, flexShrink: 0 },
    cellIcon2: { background: c.accent2Soft, color: accent2 },
    cellTag: { ...chipTag },
    cellTag2: { color: accent2, background: c.accent2Soft },
    cellBadge: {
      fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.04em",
      borderRadius: 5, padding: "2px 7px", flexShrink: 0,
    },
    cellHint: { fontSize: 10.5, color: c.muted, lineHeight: 1.4, marginTop: "auto" },

    dz: {
      border: `1.5px dashed ${c.border}`, borderRadius: 11, padding: "22px 14px",
      display: "flex", flexDirection: "column", alignItems: "center", gap: 6, textAlign: "center",
      cursor: "pointer", background: c.panel, transition: "all .15s", flex: 1, justifyContent: "center",
    },
    dzCompact: { padding: "14px 12px", flex: "none" },
    dzActive: { borderColor: accent, background: c.accentSoft },
    dzActive2: { borderColor: accent2, background: c.accent2Soft },
    dzIcon: { width: 34, height: 34, borderRadius: 9, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${accent}22, ${accent2}18)`, color: accent },
    dzIcon2: { color: accent2, background: `linear-gradient(135deg, ${accent2}22, ${accent2}10)` },

    chipList: { display: "flex", flexDirection: "column", gap: 6 },
    fileChip: { display: "flex", alignItems: "center", gap: 8, borderRadius: 9, padding: "9px 10px" },
    fileChipWarn: { border: `1px solid ${accent2}44`, background: c.accent2Soft },
    chipTag2: { color: accent2, background: c.accent2Soft },
    chipTagWarn: { color: accent2, background: "#fbdcd2" },
    chipName: { fontSize: 12, whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis", color: c.text, flex: 1, minWidth: 0 },
    chipX: { background: "transparent", border: "none", color: c.muted, cursor: "pointer", display: "grid", placeItems: "center", padding: 2, flexShrink: 0 },
    unverified: { fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", color: accent2, flexShrink: 0 },

    addrRow: { display: "flex", alignItems: "center", gap: 7, border: `1px solid ${c.border}`, borderRadius: 9, padding: "4px 4px 4px 10px", background: c.panel },
    addrInput: { flex: 1, border: "none", background: "transparent", color: c.text, fontSize: 12, outline: "none", padding: "6px 0" },
    addrBtn: { background: c.accent2Soft, border: "none", color: accent2, borderRadius: 7, width: 28, height: 28, display: "grid", placeItems: "center", cursor: "pointer", flexShrink: 0 },

    evidenceFooter: {
      display: "flex", justifyContent: "space-between", alignItems: "center", gap: 16, flexWrap: "wrap",
      marginTop: 16, paddingTop: 14, borderTop: `1px solid ${c.border}`,
    },
    runGroup: { display: "flex", alignItems: "center", gap: 14, marginLeft: "auto" },
    privacyNote: { display: "flex", gap: 8, fontSize: 11, color: c.muted, lineHeight: 1.45, alignItems: "center", flex: "1 1 320px", minWidth: 0 },

    /* run bar */
    runBar: { display: "flex", justifyContent: "space-between", alignItems: "center", gap: 14, background: c.panel, border: `1px solid ${c.border}`, borderRadius: 14, padding: "16px 20px" },
    statusDot: { width: 9, height: 9, borderRadius: "50%", flexShrink: 0 },
    runBtn: { display: "flex", alignItems: "center", gap: 7, color: "#fff", border: "none", borderRadius: 10, padding: "11px 22px", fontWeight: 650, fontSize: 13.5, cursor: "pointer", flexShrink: 0, background: `linear-gradient(135deg, ${accent}, ${accent2})` },
    runBtnDisabled: { opacity: 0.4, cursor: "not-allowed", filter: "grayscale(0.4)" },
    errorBox: { display: "flex", gap: 9, alignItems: "center", background: c.accent2Soft, border: `1px solid ${accent2}`, color: accent2, borderRadius: 11, padding: "12px 15px", fontSize: 13 },

    /* results */
    resultsHead: { display: "flex", justifyContent: "space-between", alignItems: "center", marginTop: 6 },
    ghostBtn: { display: "flex", alignItems: "center", gap: 6, background: c.panel, border: `1px solid ${c.border}`, color: c.text, borderRadius: 9, padding: "8px 13px", fontSize: 12.5, cursor: "pointer", fontWeight: 600 },
    legend: { display: "flex", alignItems: "center", gap: 18, fontSize: 12, color: c.text, background: c.panel2, border: `1px solid ${c.border}`, borderRadius: 10, padding: "9px 15px" },
    dot: { width: 8, height: 8, borderRadius: "50%", display: "inline-block" },
    groupLabel: { display: "flex", alignItems: "center", gap: 9, fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.06em", color: c.muted, marginTop: 6 },
    groupBar: { width: 20, height: 2, borderRadius: 2, background: `linear-gradient(90deg, ${accent}, ${accent2})` },
    acc: { background: c.panel, border: `1px solid ${c.border}`, borderRadius: 12, overflow: "hidden" },
    accSubmission: { background: c.panel, border: `1px solid ${accent2}55`, boxShadow: `0 0 0 1px ${accent2}18` },
    accHead: { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "14px 16px", background: "transparent", border: "none", color: c.text, cursor: "pointer" },
    accIcon: { width: 28, height: 28, borderRadius: 8, display: "grid", placeItems: "center", background: c.accentSoft, color: accent },
    accIcon2: { background: c.accent2Soft, color: accent2 },
    accBody: { padding: "0 16px 16px", borderTop: `1px solid ${c.border}` },
    miniBtn: { display: "flex", alignItems: "center", gap: 5, background: c.panel2, border: `1px solid ${c.border}`, color: c.muted, borderRadius: 7, padding: "6px 11px", fontSize: 11.5, cursor: "pointer" },
    prose: { fontSize: 13.5, lineHeight: 1.6, color: c.text, paddingTop: 10 },
    tablePre: { fontFamily: mono, fontSize: 12, lineHeight: 1.55, color: c.text, paddingTop: 10, margin: 0, whiteSpace: "pre-wrap", overflowX: "auto" },
    inlineTag: { fontFamily: mono, fontSize: 11.5, fontWeight: 700, color: accent, background: c.accentSoft, borderRadius: 4, padding: "1px 5px", margin: "0 1px" },
    verifyTag: { fontFamily: mono, fontSize: 11, fontWeight: 700, color: accent2, background: c.accent2Soft, borderRadius: 4, padding: "1px 5px", margin: "0 1px" },

    /* advanced/optional intake */
    advToggle: { display: "flex", alignItems: "center", gap: 7, marginTop: 16, background: "transparent", border: "none", color: c.text, fontSize: 13, fontWeight: 650, cursor: "pointer", padding: "6px 0" },
    advHint: { fontSize: 11, color: c.muted, fontWeight: 400, marginLeft: 4 },
    advWrap: { marginTop: 14, paddingTop: 16, borderTop: `1px solid ${c.border}`, display: "flex", flexDirection: "column", gap: 16 },
    advGrid: { display: "grid", gridTemplateColumns: "repeat(2, 1fr)", gap: 14 },
    advTextarea: { width: "100%", minHeight: 84, padding: "10px 12px", borderRadius: 10, border: `1px solid ${c.border}`, background: c.panel2, color: c.text, fontSize: 13, lineHeight: 1.5, fontFamily: sans, boxSizing: "border-box", resize: "vertical" },
    targetBox: { border: `1px solid ${accent2}44`, background: c.accent2Soft, borderRadius: 11, padding: "12px 14px" },
    internalChip: { fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: accent2, marginLeft: "auto" },

    /* ROV document */
    rovDoc: { background: c.panel, border: `1px solid ${c.border}`, borderRadius: 14, padding: "28px 32px" },
    manualPanel: { background: c.accent2Soft, border: `1px solid ${accent2}55`, borderRadius: 12, padding: "14px 16px" },
    manualRow: { display: "flex", alignItems: "center", gap: 10, padding: "7px 0", borderTop: `1px solid ${accent2}22` },
    manualInput: { width: 64, padding: "6px 22px 6px 8px", borderRadius: 7, border: `1px solid ${c.border}`, background: c.panel, color: c.text, fontFamily: mono, fontSize: 13, textAlign: "right", boxSizing: "border-box" },
    manualUnit: { position: "absolute", right: 8, fontSize: 11, color: c.muted, pointerEvents: "none" },
    mdH: { fontWeight: 750, letterSpacing: "-0.01em", color: c.text, marginBottom: 8 },
    mdP: { fontSize: 13.5, lineHeight: 1.62, color: c.text, margin: "0 0 11px" },
    mdHr: { border: "none", borderTop: `1px solid ${c.border}`, margin: "20px 0" },
    mdUl: { margin: "0 0 12px", paddingLeft: 22, fontSize: 13.5, lineHeight: 1.6, color: c.text },
    mdOl: { margin: "0 0 12px", paddingLeft: 22, fontSize: 13.5, lineHeight: 1.6, color: c.text },
    mdTable: { borderCollapse: "collapse", width: "100%", margin: "12px 0", fontSize: 12.5 },
    mdTh: { border: `1px solid ${c.border}`, padding: "7px 10px", textAlign: "left", background: c.panel2, fontWeight: 700, fontFamily: mono, fontSize: 11.5 },
    mdTd: { border: `1px solid ${c.border}`, padding: "7px 10px", textAlign: "left", fontFamily: mono, fontSize: 11.5 },

    /* internal notes */
    notesCard: { background: c.accent2Soft, border: `1px solid ${accent2}55`, borderRadius: 13, overflow: "hidden" },
    notesHead: { width: "100%", display: "flex", justifyContent: "space-between", alignItems: "center", padding: "13px 16px", background: "transparent", border: "none", color: c.text, cursor: "pointer" },
    notesIcon: { width: 26, height: 26, borderRadius: 7, display: "grid", placeItems: "center", background: dark ? "#f3cabc" : "#fbd9cd", color: accent2 },
    notesTag: { fontSize: 9.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.03em", color: accent2, border: `1px solid ${accent2}55`, borderRadius: 5, padding: "2px 6px" },
    notesBody: { padding: "4px 16px 16px", borderTop: `1px solid ${accent2}33` },
    disclaimerRow: { fontSize: 11, color: c.muted, textAlign: "center", padding: "4px 0" },
    textarea: { width: "100%", minHeight: 240, marginTop: 6, padding: 13, borderRadius: 10, border: `1px solid ${c.border}`, background: c.panel2, color: c.text, fontSize: 13, lineHeight: 1.55, fontFamily: sans, boxSizing: "border-box", resize: "vertical" },
    placeholder: { display: "flex", flexDirection: "column", alignItems: "center", gap: 10, padding: "52px 20px", border: `1.5px dashed ${c.border}`, borderRadius: 14, background: c.panel },
    placeholderIcon: { width: 48, height: 48, borderRadius: 12, display: "grid", placeItems: "center", background: `linear-gradient(135deg, ${accent}22, ${accent2}22)`, color: accent },
  };
}

function globalCss(t) {
  return `
    * { box-sizing: border-box; }
    body { margin: 0; background: ${t.bg}; }
    .spin { animation: spin 0.9s linear infinite; }
    @keyframes spin { to { transform: rotate(360deg); } }
    input:focus, select:focus, textarea:focus { outline: 2px solid ${t.accent}55; outline-offset: 1px; }
    button:focus-visible { outline: 2px solid ${t.accent}; outline-offset: 2px; }
    ::selection { background: ${t.accent}44; }
    @media (max-width: 760px) {
      div[style*="grid-template-columns: 1fr 1.35fr"] { grid-template-columns: 1fr !important; }
      div[style*="grid-template-columns: 1fr 1fr"] { grid-template-columns: 1fr !important; }
    }
    @media (prefers-reduced-motion: reduce) { .spin { animation: none; } }
  `;
}
