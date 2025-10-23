// api/hub.js
// Robust hub/debug endpoints for Guardian. Tries to use your ./_lib/kv.js if available,
// otherwise falls back to constructing an Upstash Redis client from env vars.
//
// Temporary debug endpoints:
//  - GET  /api/hub/status       -> basic health
//  - GET  /api/debug/token      -> shows whether an access token exists in today's state
//  - POST /api/debug/clear      -> clears access token keys from today's state
//
// Remove debug endpoints after troubleshooting.

async function buildKV() {
  // try to import your kv module dynamically (works whether it exports kv/todayKey or not)
  try {
    const mod = await import("./_lib/kv.js");
    // if user exported kv and todayKey, use them
    const kv = mod.kv ?? mod.default ?? null;
    const todayKey = mod.todayKey ?? mod.todayKey ?? mod.todayKey ?? (mod.todayKey === undefined ? null : mod.todayKey);
    // if both kv and todayKey available return them
    if (kv && typeof mod.todayKey === "function") {
      return { kv, todayKey: mod.todayKey, from: "module" };
    }
    // else try named exports for helpers getState / setState
    if (mod.getState && mod.setState && mod.todayKey) {
      return { kv: { get: async (k) => mod.getState(), set: async (k, v) => mod.setState(v) }, todayKey: mod.todayKey, from: "module-getters" };
    }
    // If we have only kv or only todayKey, still return what we have
    if (kv && typeof mod.todayKey === "function") {
      return { kv, todayKey: mod.todayKey, from: "partial-module" };
    }
    // otherwise fallthrough to fallback
  } catch (e) {
    // ignore, we'll fallback
    // console.error("dynamic import of _lib/kv.js failed:", e);
  }

  // fallback: construct a Redis client using upstash REST URL + token
  try {
    const { Redis } = await import("@upstash/redis");
    const url = process.env.UPSTASH_REDIS_REST_URL || "";
    const token = process.env.UPSTASH_REDIS_REST_TOKEN || "";
    if (!url || !token) {
      throw new Error("Missing UPSTASH_REDIS_REST_URL or UPSTASH_REDIS_REST_TOKEN env var for fallback");
    }
    const kv = new Redis({ url, token });
    // local todayKey implementation (same as typical kv.js)
    const IST = "Asia/Kolkata";
    function todayKey(d = new Date()) {
      const now = new Date(d.toLocaleString("en-US", { timeZone: IST }));
      const y = now.getFullYear();
      const m = String(now.getMonth() + 1).padStart(2, "0");
      const day = String(now.getDate()).padStart(2, "0");
      return `${y}-${m}-${day}`;
    }
    return { kv, todayKey, from: "fallback" };
  } catch (e) {
    // final fallback: throw a clear error
    throw new Error("Cannot initialize KV: " + (e && e.message ? e.message : String(e)));
  }
}

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

// local helpers to read/write today's state (use kv.get / kv.set)
async function getStateUsingKV(kv, todayKeyFn) {
  const key = `risk:${todayKeyFn()}`;
  // upstash redis client exposes get() and set()
  const v = await kv.get(key);
  return v || {};
}
async function setStateUsingKV(kv, todayKeyFn, patch = {}) {
  const key = `risk:${todayKeyFn()}`;
  const cur = (await kv.get(key)) || {};
  const next = { ...cur, ...patch };
  await kv.set(key, next);
  return next;
}

// main handler
export default async function handler(req, res) {
  try {
    // initialize kv (cached per invocation by Node if warm)
    if (!global.__HUB_KV_READY) {
      global.__HUB_KV = await buildKV();
      global.__HUB_KV_READY = true;
      // store shorter refs
      global.__HUB_KV.kvRef = global.__HUB_KV.kv;
      global.__HUB_KV.todayKeyFn = global.__HUB_KV.todayKey;
    }
    const { kv: kvRef, todayKeyFn, from } = global.__HUB_KV;

    // normalize URL
    const host = req.headers.host || "localhost";
    const url = new URL(req.url, `https://${host}`);
    const path = url.pathname || "/";

    // Basic status / debug routes
    if (path === "/api/hub/status" && req.method === "GET") {
      return ok(res, {
        status: "hub ok",
        time: new Date().toISOString(),
        kv_source: from,
        state_key: todayKeyFn()
      });
    }

    if (path === "/api/debug/token" && req.method === "GET") {
      const s = await getStateUsingKV(kvRef, todayKeyFn);
      const t = s?.access_token || s?.accessToken || "";
      return ok(res, {
        has_token: !!t,
        token_masked: maskToken(t),
        state_key: todayKeyFn(),
        raw_state_keys: Object.keys(s || {})
      });
    }

    if (path === "/api/debug/clear" && req.method === "POST") {
      const s = (await getStateUsingKV(kvRef, todayKeyFn)) || {};
      const next = { ...s };
      delete next.access_token;
      delete next.accessToken;
      await setStateUsingKV(kvRef, todayKeyFn, next);
      return ok(res, { cleared: true, state_key: todayKeyFn() });
    }

    return bad(res, "Unknown hub route", 404);
  } catch (err) {
    console.error("hub.js handler error:", err && err.stack ? err.stack : err);
    return send(res, 500, { ok: false, error: err?.message || String(err) });
  }
}
