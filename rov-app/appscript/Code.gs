/**
 * ROV Assistant — Google Apps Script backend (Web App).
 *
 * Replaces the Cloudflare Worker. Deployed as a Web App, it:
 *   - holds the Anthropic API key in Script Properties (never in client code)
 *   - accepts the case facts + base64 PDFs from the browser
 *   - calls the Anthropic Messages API (non-streaming — Apps Script can't stream)
 *   - returns the full ROV markdown as JSON
 *   - applies a simple per-user daily rate limit via the Cache/Properties service
 *
 * IMPORTANT CONSTRAINTS (why this differs from the Worker):
 *   - No streaming. The browser waits, then renders the whole ROV at once.
 *   - ~6 minute max execution time. One ROV is well within this, but it's a hard cap.
 *   - CORS: Apps Script Web Apps deployed "Anyone" return permissive CORS for the
 *     POST; we still verify an app token to stop random callers using your key.
 *
 * SETUP (see LAUNCH_CHECKLIST.md):
 *   1. Project Settings → Script Properties:
 *        ANTHROPIC_API_KEY = sk-ant-...
 *        APP_TOKEN         = <a long random string you also put in the web app's .env>
 *        ANTHROPIC_MODEL   = claude-sonnet-4-6      (optional; default below)
 *        MAX_TOKENS        = 8000                    (optional)
 *        RATE_LIMIT_PER_DAY= 40                      (optional)
 *   2. Deploy → New deployment → Web app
 *        Execute as: Me
 *        Who has access: Anyone
 *   3. Copy the /exec URL into the web app's VITE_API_BASE.
 */

var ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
var ANTHROPIC_VERSION = '2023-06-01';

function prop(key, dflt) {
  var v = PropertiesService.getScriptProperties().getProperty(key);
  return (v === null || v === undefined || v === '') ? dflt : v;
}

/** Health check: GET the /exec URL in a browser to confirm it's live. */
function doGet() {
  return json({ ok: true, service: 'rov-appscript' });
}

/** Main endpoint. */
function doPost(e) {
  try {
    if (!e || !e.postData || !e.postData.contents) {
      return json({ error: 'Empty request.' });
    }
    var body = JSON.parse(e.postData.contents);

    // App token check — stops arbitrary callers from spending your key.
    var expected = prop('APP_TOKEN', '');
    if (expected && body.token !== expected) {
      return json({ error: 'Unauthorized.' });
    }

    var apiKey = prop('ANTHROPIC_API_KEY', '');
    if (!apiKey) return json({ error: 'Server not configured (missing API key).' });

    // Simple per-day rate limit keyed by the caller-provided clientId (or IP-less fallback).
    var perDay = parseInt(prop('RATE_LIMIT_PER_DAY', '40'), 10);
    var who = String(body.clientId || 'shared');
    if (rateLimited(who, perDay)) {
      return json({ error: 'Daily limit reached. Try again tomorrow.' });
    }

    var caseInfo = body.caseInfo || {};
    var documents = body.documents || [];
    var ledgerText = body.ledgerText || '';
    var manualDistances = body.manualDistances || {}; // { "CMP-01": 3.2, ... } from a prior round

    // ---- PASS 1: extract subject + comp addresses from the PDFs (cheap call) ----
    // Then geocode and compute straight-line distances. Any comp that can't be
    // resolved is returned to the client so it can show a manual-distance field.
    var distanceBlock = '';
    var needsManual = [];
    try {
      var geo = computeDistances(documents, apiKey, manualDistances);
      distanceBlock = geo.promptBlock;
      needsManual = geo.needsManual;
    } catch (geoErr) {
      // Geocoding is best-effort; never block the ROV if it fails.
      distanceBlock = '';
      needsManual = [];
    }

    // ---- PASS 2: generate the ROV, with computed distances injected ----
    var content = buildContentBlocks(documents);
    content.push({ type: 'text', text: buildUserMessage(caseInfo, ledgerText) + distanceBlock });

    var payload = {
      model: prop('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
      max_tokens: parseInt(prop('MAX_TOKENS', '8000'), 10),
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: content }]
    };

    var res = UrlFetchApp.fetch(ANTHROPIC_URL, {
      method: 'post',
      contentType: 'application/json',
      headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var code = res.getResponseCode();
    var text = res.getContentText();
    if (code < 200 || code >= 300) {
      return json({ error: 'Upstream error (' + code + ')', detail: text.slice(0, 500) });
    }

    var data = JSON.parse(text);
    var rov = '';
    if (data.content && data.content.length) {
      for (var j = 0; j < data.content.length; j++) {
        if (data.content[j].type === 'text') rov += data.content[j].text;
      }
    }
    return json({ rov: rov, needsManual: needsManual });
  } catch (err) {
    return json({ error: 'Server error: ' + (err && err.message ? err.message : err) });
  }
}

/** Build the PDF document blocks (shared by both passes). */
function buildContentBlocks(documents) {
  var content = [];
  for (var i = 0; i < documents.length; i++) {
    var d = documents[i];
    if (!d || !d.base64) continue;
    var block = {
      type: 'document',
      source: { type: 'base64', media_type: d.mediaType || 'application/pdf', data: d.base64 }
    };
    if (d.tag === 'APP-01') block.cache_control = { type: 'ephemeral' };
    content.push(block);
  }
  return content;
}

/**
 * PASS 1 + geocode. Returns:
 *   { promptBlock: "\n\nCOMPUTED DISTANCES ...", needsManual: [{tag, address}] }
 * - Extracts the subject + comp addresses from the PDFs via a cheap Claude call.
 * - Geocodes each with Apps Script's built-in Maps service (no extra key).
 * - Straight-line (haversine) distance, rounded to nearest 0.1 mi.
 * - Any comp the user already supplied a manual distance for is used as-is.
 * - Any comp that can't be geocoded confidently is returned in needsManual.
 */
function computeDistances(documents, apiKey, manualDistances) {
  var out = { promptBlock: '', needsManual: [] };
  if (!documents || !documents.length) return out;

  // ---- extract addresses (Pass 1) ----
  var content = buildContentBlocks(documents);
  content.push({ type: 'text', text:
    'Read the attached PDFs. Return ONLY compact JSON (no prose, no code fence) of the form: ' +
    '{"subject":"<full street address of the SUBJECT property from the appraisal APP-01>",' +
    '"comps":[{"tag":"CMP-01","address":"<full street address of that comparable sale>"}, ...]}. ' +
    'Include one comps entry per MLS comparable sheet (CMP-01, CMP-02, ...), matching the tag order. ' +
    'Use the most complete street address available (street, city, state). If an address is not present for a comp, use an empty string for that comp.'
  });

  var extractRes = UrlFetchApp.fetch(ANTHROPIC_URL, {
    method: 'post',
    contentType: 'application/json',
    headers: { 'x-api-key': apiKey, 'anthropic-version': ANTHROPIC_VERSION },
    payload: JSON.stringify({
      model: prop('ANTHROPIC_MODEL', 'claude-sonnet-4-6'),
      max_tokens: 700,
      messages: [{ role: 'user', content: content }]
    }),
    muteHttpExceptions: true
  });
  if (extractRes.getResponseCode() >= 300) return out;

  var parsed;
  try {
    var raw = JSON.parse(extractRes.getContentText());
    var txt = '';
    for (var i = 0; i < raw.content.length; i++) if (raw.content[i].type === 'text') txt += raw.content[i].text;
    txt = txt.replace(/^```(json)?/i, '').replace(/```$/, '').trim();
    var a = txt.indexOf('{'), b = txt.lastIndexOf('}');
    parsed = JSON.parse(txt.slice(a, b + 1));
  } catch (e) { return out; }

  if (!parsed || !parsed.subject || !parsed.comps) return out;

  // ---- geocode subject ----
  var subj = geocodeConfident(parsed.subject);
  if (!subj) {
    // Without a subject coordinate we can't compute anything; ask for all manually.
    for (var c0 = 0; c0 < parsed.comps.length; c0++) {
      out.needsManual.push({ tag: parsed.comps[c0].tag, address: parsed.comps[c0].address || '' });
    }
    return out;
  }

  // ---- per-comp distance ----
  var lines = [];
  for (var c = 0; c < parsed.comps.length; c++) {
    var comp = parsed.comps[c];
    var tag = comp.tag || ('CMP-' + ('0' + (c + 1)).slice(-2));

    // user-supplied manual distance wins
    if (manualDistances && manualDistances[tag] != null && manualDistances[tag] !== '') {
      var md = Math.round(parseFloat(manualDistances[tag]) * 10) / 10;
      if (!isNaN(md)) { lines.push(tag + ': ' + md.toFixed(1) + ' mi (loan-officer confirmed)'); continue; }
    }

    var g = geocodeConfident(comp.address);
    if (!g) { out.needsManual.push({ tag: tag, address: comp.address || '' }); continue; }

    var miles = haversineMiles(subj.lat, subj.lng, g.lat, g.lng);
    // sanity guard: implausible local-comp distance => treat as failed geocode
    if (miles > 100) { out.needsManual.push({ tag: tag, address: comp.address || '' }); continue; }

    lines.push(tag + ': ' + (Math.round(miles * 10) / 10).toFixed(1) + ' mi');
  }

  if (lines.length) {
    out.promptBlock =
      '\n\nCOMPUTED STRAIGHT-LINE DISTANCES (subject to each comparable, geocoded; use these exact figures in the report, e.g. "3.2 mi"; these are authoritative — do not omit or mark them as unknown):\n' +
      lines.join('\n');
  }
  return out;
}

/** Geocode with confidence guards. Returns {lat,lng} or null. */
function geocodeConfident(address) {
  if (!address || !String(address).trim()) return null;
  try {
    var r = Maps.newGeocoder().geocode(address);
    if (!r || r.status !== 'OK' || !r.results || !r.results.length) return null;
    var top = r.results[0];
    // reject vague hits: partial matches, or results that are only a town/region
    if (top.partial_match === true) return null;
    var t = top.geometry && top.geometry.location_type;
    if (t === 'APPROXIMATE') {
      // APPROXIMATE is typically locality-level — too coarse for a comp distance
      return null;
    }
    return { lat: top.geometry.location.lat, lng: top.geometry.location.lng };
  } catch (e) {
    return null;
  }
}

/** Straight-line distance in statute miles (haversine). */
function haversineMiles(lat1, lng1, lat2, lng2) {
  var R = 3958.7613; // Earth radius in miles
  var toRad = function (d) { return d * Math.PI / 180; };
  var dLat = toRad(lat2 - lat1), dLng = toRad(lng2 - lng1);
  var a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
          Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
          Math.sin(dLng / 2) * Math.sin(dLng / 2);
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/** Per-day counter using the script cache (best-effort) + properties (durable). */
function rateLimited(who, perDay) {
  if (!perDay || perDay <= 0) return false;
  var key = 'rl_' + Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'yyyyMMdd') + '_' + who;
  var props = PropertiesService.getScriptProperties();
  var n = parseInt(props.getProperty(key) || '0', 10) + 1;
  props.setProperty(key, String(n));
  return n > perDay;
}

function json(obj) {
  return ContentService
    .createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}
