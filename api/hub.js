// api/hub.js
// Lightweight hub / debug endpoint for the Guardian app.
// TEMP: includes debug routes — remove them once you're done troubleshooting.

import { instance } from "./_lib/kite.js"; // existing kite instance
import { kv, todayKey, getState, setState, IST } from "./_lib/kv.js";

/**
 * Small response helpers
 */
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request", code = 400) =>
  send(res, code, { ok: false, error: msg });

/**
 * Mask an access token for display (first 6 + last 6)
 */
function maskToken(t = "") {
  if (!t) return "";
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

/**
 * Exported serverless function handler.
 * All returns MUST be inside this function (avoid top-level returns).
 */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname || "/";

    // ---------- DEBUG ROUTES (temporary) ----------
    // 1) GET /api/debug/token -> show whether access_token exists (masked)
    if (path === "/api/debug/token" && req.method === "GET") {
      const s = await getState();
      const t = s?.access_token || s?.accessToken || "";
      return ok(res, { has_token: !!t, token_masked: maskToken(t), state_key: todayKey() });
    }

    // 2) POST /api/debug/clear -> remove stored access_token in today's state
    if (path === "/api/debug/clear" && req.method === "POST") {
      const s = (await getState()) || {};
      const next = { ...s };
      delete next.access_token;
      delete next.accessToken;
      await setState(next);
      return ok(res, { cleared: true, state_key: todayKey() });
    }
    // ---------- end DEBUG ----------

    // Small status endpoint
    if (path === "/api/hub/status" && req.method === "GET") {
      return ok(res, { status: "hub ok", time: new Date().toISOString(), state_key: todayKey() });
    }

    // If not a known route, reply with a helpful message (no crash)
    return bad(res, "Unknown hub route", 404);
  } catch (err) {
    // Log error server-side (Vercel function logs)
    console.error("hub.js handler error:", err);
    return send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}
