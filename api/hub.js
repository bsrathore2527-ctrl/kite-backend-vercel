// api/hub.js
// Hub + small debug endpoints for the Guardian app.
// This file reads/writes today's KV via `kv` (so it works even if your _lib/kv.js
// doesn't export getState/setState helpers). Remove debug routes after testing.

import { instance } from "./_lib/kite.js"; // existing kite instance (not used by debug routes)
import { kv, todayKey, IST } from "./_lib/kv.js"; // only import what must exist

// ---------- small helpers ----------
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request", code = 400) =>
  send(res, code, { ok: false, error: msg });

function maskToken(t = "") {
  if (!t) return "";
  if (t.length <= 12) return t;
  return `${t.slice(0, 6)}…${t.slice(-6)}`;
}

// Local getState/setState using kv (works even if your _lib/kv.js didn't export helpers)
async function getStateLocal() {
  const key = `risk:${todayKey()}`;
  const v = await kv.get(key);
  return v || {};
}
async function setStateLocal(patch = {}) {
  const key = `risk:${todayKey()}`;
  const cur = (await kv.get(key)) || {};
  const next = { ...cur, ...patch };
  await kv.set(key, next);
  return next;
}

// ---------- handler ----------
export default async function handler(req, res) {
  try {
    // normalize URL
    const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
    const path = url.pathname || "/";

    // Debug: status
    if (path === "/api/hub/status" && req.method === "GET") {
      return ok(res, {
        status: "hub ok",
        time: new Date().toISOString(),
        state_key: todayKey()
      });
    }

    // Debug: show whether a token is present in today's state
    if (path === "/api/debug/token" && req.method === "GET") {
      const s = await getStateLocal();
      const t = s?.access_token || s?.accessToken || "";
      return ok(res, {
        has_token: !!t,
        token_masked: maskToken(t),
        state_key: todayKey(),
        raw_state_keys: Object.keys(s)
      });
    }

    // Debug: clear token from today's state
    if (path === "/api/debug/clear" && req.method === "POST") {
      const s = (await getStateLocal()) || {};
      const next = { ...s };
      delete next.access_token;
      delete next.accessToken;
      await setStateLocal(next);
      return ok(res, { cleared: true, state_key: todayKey() });
    }

    // If route not recognized
    return bad(res, "Unknown hub route", 404);
  } catch (err) {
    console.error("hub.js handler error:", err);
    return send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}
