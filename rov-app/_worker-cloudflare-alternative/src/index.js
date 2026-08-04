// ROV Worker — API proxy for the Anthropic Messages API.
// Holds the API key as a secret, forwards PDFs as document blocks,
// streams the response, enforces CORS + a small-team rate limit.
//
// Endpoints:
//   GET  /health   -> { ok: true }
//   POST /api/rov  -> streams the ROV markdown back (text/plain stream)
//
// This is the SCAFFOLD. Step 2 fills in the document-block assembly and
// wires the frontend to it; the request/response shapes below are the contract.

import { SYSTEM_PROMPT, buildUserMessage } from "./prompt.js";

const ANTHROPIC_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";

// --- tiny in-memory rate limiter (per-isolate; fine for a small team) ---
// For durable limiting across all edge locations, swap for KV (see wrangler.toml).
const hits = new Map(); // ip -> number[] (timestamps ms)

function rateLimited(ip, max, windowSec) {
  const now = Date.now();
  const windowMs = windowSec * 1000;
  const arr = (hits.get(ip) || []).filter((t) => now - t < windowMs);
  arr.push(now);
  hits.set(ip, arr);
  return arr.length > max;
}

function corsHeaders(origin, allowed) {
  const ok = allowed === "*" || origin === allowed;
  return {
    "Access-Control-Allow-Origin": ok ? (origin || allowed) : allowed,
    "Access-Control-Allow-Methods": "POST, GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
  };
}

function json(body, status, cors) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...cors },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const origin = request.headers.get("Origin") || "";
    const cors = corsHeaders(origin, env.ALLOWED_ORIGIN);

    // Preflight
    if (request.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: cors });
    }

    // Health check
    if (url.pathname === "/health" && request.method === "GET") {
      return json({ ok: true, service: "rov-worker" }, 200, cors);
    }

    // Main endpoint
    if (url.pathname === "/api/rov" && request.method === "POST") {
      // Enforce origin
      if (env.ALLOWED_ORIGIN !== "*" && origin !== env.ALLOWED_ORIGIN) {
        return json({ error: "Origin not allowed" }, 403, cors);
      }

      // Rate limit
      const ip = request.headers.get("CF-Connecting-IP") || "unknown";
      const max = parseInt(env.RATE_LIMIT_MAX || "40", 10);
      const win = parseInt(env.RATE_LIMIT_WINDOW_SECONDS || "3600", 10);
      if (rateLimited(ip, max, win)) {
        return json({ error: "Rate limit exceeded. Try again later." }, 429, cors);
      }

      if (!env.ANTHROPIC_API_KEY) {
        return json({ error: "Server not configured (missing API key)." }, 500, cors);
      }

      let payload;
      try {
        payload = await request.json();
      } catch {
        return json({ error: "Invalid JSON body." }, 400, cors);
      }

      // Expected body from the frontend:
      // {
      //   caseInfo: { address, borrower, appraisedValue, targetRange, specialIssues, loanNo, ... },
      //   documents: [ { tag: "APP-01", name, base64, mediaType: "application/pdf" }, ... ],
      //   ledgerText: "APP-01 [appraisal] file.pdf\nCMP-01 ..."   // human-readable ledger
      // }
      const { caseInfo = {}, documents = [], ledgerText = "" } = payload;

      // Assemble the Anthropic message content: all PDFs first, then the user text.
      const content = [];
      for (const doc of documents) {
        if (!doc.base64) continue;
        content.push({
          type: "document",
          source: {
            type: "base64",
            media_type: doc.mediaType || "application/pdf",
            data: doc.base64,
          },
          // Prompt-cache the appraisal so Regenerate is cheap (step 4 expands this).
          ...(doc.tag === "APP-01" ? { cache_control: { type: "ephemeral" } } : {}),
        });
      }
      content.push({ type: "text", text: buildUserMessage(caseInfo, ledgerText) });

      const anthropicBody = {
        model: env.ANTHROPIC_MODEL || "claude-sonnet-4-6",
        max_tokens: parseInt(env.MAX_TOKENS || "8000", 10),
        stream: true,
        system: SYSTEM_PROMPT,
        messages: [{ role: "user", content }],
      };

      // Call Anthropic and stream the text deltas straight back to the browser.
      const upstream = await fetch(ANTHROPIC_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-api-key": env.ANTHROPIC_API_KEY,
          "anthropic-version": ANTHROPIC_VERSION,
        },
        body: JSON.stringify(anthropicBody),
      });

      if (!upstream.ok || !upstream.body) {
        const errText = await upstream.text().catch(() => "");
        return json({ error: "Upstream error", detail: errText.slice(0, 500) }, 502, cors);
      }

      // Transform Anthropic's SSE stream into a plain text token stream.
      const stream = sseToText(upstream.body);
      return new Response(stream, {
        status: 200,
        headers: {
          "Content-Type": "text/plain; charset=utf-8",
          "Cache-Control": "no-store",
          ...cors,
        },
      });
    }

    return json({ error: "Not found" }, 404, cors);
  },
};

// Parse Anthropic's Server-Sent Events and emit only the text deltas.
function sseToText(body) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = "";

  return new ReadableStream({
    async pull(controller) {
      const { done, value } = await reader.read();
      if (done) { controller.close(); return; }
      buffer += decoder.decode(value, { stream: true });

      let idx;
      while ((idx = buffer.indexOf("\n")) !== -1) {
        const line = buffer.slice(0, idx).trim();
        buffer = buffer.slice(idx + 1);
        if (!line.startsWith("data:")) continue;
        const data = line.slice(5).trim();
        if (data === "[DONE]") continue;
        try {
          const evt = JSON.parse(data);
          if (evt.type === "content_block_delta" && evt.delta?.type === "text_delta") {
            controller.enqueue(encoder.encode(evt.delta.text));
          }
        } catch {
          // ignore keep-alives / non-JSON lines
        }
      }
    },
    cancel() { reader.cancel(); },
  });
}
