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

    // Build the Anthropic message content: PDFs first, then the user text.
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
    content.push({ type: 'text', text: buildUserMessage(caseInfo, ledgerText) });

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
    return json({ rov: rov });
  } catch (err) {
    return json({ error: 'Server error: ' + (err && err.message ? err.message : err) });
  }
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
