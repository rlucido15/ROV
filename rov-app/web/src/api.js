// Client helper for the Google Apps Script backend.
//
// Apps Script Web Apps cannot stream, so this makes one request and returns the
// full ROV markdown when it's ready. To avoid a CORS preflight (which Apps Script
// handles poorly), we send the body as text/plain — a "simple" request. The
// Worker version streamed; this one resolves once with the whole document.

const API_BASE = import.meta.env.VITE_API_BASE || "";     // the Apps Script /exec URL
const APP_TOKEN = import.meta.env.VITE_APP_TOKEN || "";   // shared secret, matches Script Property

const MAX_PDF_BYTES = 32 * 1024 * 1024; // Anthropic per-PDF limit

// Stable-ish per-browser id for daily rate limiting (not PII; random once per browser).
function clientId() {
  try {
    let id = localStorage.getItem("rov_client_id");
    if (!id) { id = Math.random().toString(36).slice(2) + Date.now().toString(36); localStorage.setItem("rov_client_id", id); }
    return id;
  } catch { return "anon"; }
}

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const s = String(reader.result);
      resolve(s.slice(s.indexOf(",") + 1)); // strip "data:...;base64,"
    };
    reader.onerror = () => reject(new Error("Failed to read " + file.name));
    reader.readAsDataURL(file);
  });
}

/**
 * @param {object}   caseInfo
 * @param {Array}    files    [{ tag, file }]
 * @param {string}   ledgerText
 * @param {function} [onToken] optional - called ONCE with the full text (kept for
 *                             API-compat with the streaming version so App.jsx works unchanged)
 * @returns {Promise<string>} the ROV markdown
 */
export async function runRov({ caseInfo, files, ledgerText, onToken }) {
  const documents = [];
  for (const { tag, file } of files) {
    if (!file) continue;
    if (file.size > MAX_PDF_BYTES) {
      throw new Error(`${file.name} is over 32MB - split it or reduce its size.`);
    }
    documents.push({
      tag,
      name: file.name,
      mediaType: file.type || "application/pdf",
      base64: await fileToBase64(file),
    });
  }

  const res = await fetch(API_BASE, {
    method: "POST",
    // text/plain avoids the CORS preflight Apps Script can't answer.
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify({
      token: APP_TOKEN,
      clientId: clientId(),
      caseInfo,
      documents,
      ledgerText,
    }),
    redirect: "follow", // Apps Script /exec issues a redirect to the content URL
  });

  if (!res.ok) {
    throw new Error(`Request failed (${res.status})`);
  }

  let data;
  try { data = await res.json(); }
  catch { throw new Error("Unexpected response from the server."); }

  if (data.error) throw new Error(data.error);
  const rov = data.rov || "";
  if (onToken) onToken(rov); // single callback so App.jsx's splitRov path still runs
  return rov;
}

/** Health check against the Apps Script /exec URL (GET). */
export async function health() {
  try {
    const r = await fetch(API_BASE, { method: "GET", redirect: "follow" });
    if (!r.ok) return false;
    const d = await r.json().catch(() => ({}));
    return !!d.ok;
  } catch {
    return false;
  }
}
