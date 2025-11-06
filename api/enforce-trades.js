// api/enforce-trades.js
import { kv, todayKey } from "./_lib/kv.js";
import { getState, setState } from "./_lib/state.js";
import { instance } from "./_lib/kite.js";
import { cancelPending, squareOffAll } from "./enforce.js";

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") return bad(res, "Method not allowed");

    const key = `risk:${todayKey()}`;
    // Prefer the canonical state in KV; fallback to getState()
    let state = (await kv.get(key)) || (await getState()) || {};

    // If nothing to enforce, return quickly
    if (!state.tripped_day && !state.block_new_orders) {
      return ok(res, { tick: new Date().toISOString(), enforced: false, reason: "not_tripped" });
    }

    // Ensure Kite client available
    let kc;
    try {
      kc = await instance();
    } catch (e) {
      return ok(res, { enforced: false, note: "Kite not connected", error: e.message });
    }

    // Run enforcement helpers
    const cancelled = await cancelPending(kc);
    const squared = await squareOffAll(kc);

    // update last enforced timestamp on persisted state
    const updated = { ...(state || {}), last_enforced_at: Date.now() };
    await kv.set(key, updated);
    if (typeof setState === "function") {
      try { await setState(updated); } catch(e){ /* ignore */ }
    }

    return ok(res, {
      tick: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
      enforced: true,
      cancelled,
      squared
    });
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
