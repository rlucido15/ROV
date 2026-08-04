# Alternative backend: Cloudflare Worker

This folder is the ORIGINAL Cloudflare Worker backend. The project switched to a
Google Apps Script backend (see `../appscript/`), so this is kept only as a
drop-in alternative if you ever want streaming + edge latency instead.

If you switch back to the Worker: restore the streaming `api.js` (git history),
deploy this with `wrangler deploy`, and point `VITE_API_BASE` at the Worker URL.
