// api/kite/funds.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

export default async function handler(req, res) {
  try {
    // Only GET allowed
    if (req.method !== "GET") {
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    let kc;
    try {
      kc = await instance();
    } catch (e) {
      // kite instance creation failed -> return cached state fallback
      const cached = (await kv.get(`state:${todayKey()}`)) || {};
      return send(res, 200, { ok: false, error: "Kite not connected", message: String(e), fallback_state: cached });
    }

    // try a few ways to read funds from the kite client (different libs use different names)
    let result = null;
    try {
      // preferred: getFunds or get_funds
      if (typeof kc.getFunds === "function") {
        result = await kc.getFunds();
      } else if (typeof kc.get_funds === "function") {
        result = await kc.get_funds();
      } else if (typeof kc.getMargins === "function") {
        result = await kc.getMargins(); // some wrappers
      } else if (typeof kc.getProfile === "function") {
        // last resort - some libs expose balance inside profile
        const prof = await kc.getProfile();
        result = { balance: prof?.balance ?? null, profile: prof };
      } else {
        // try generic properties
        result = kc.funds || kc.balance || null;
      }
    } catch (err) {
      // error while calling kite method
      return send(res, 200, { ok: false, error: "Kite method failed", message: String(err) });
    }

    // if nothing found, return informative error but not crash
    if (!result) {
      return send(res, 200, { ok: false, error: "Kite connected but funds not available", result: null });
    }

    // Normalize a small payload the UI expects
    const normalized = {
      ok: true,
      funds: result,
      // expose a few convenience fields (some code expects .balance or .funds.available.live_balance)
      balance: result.balance ?? (result.available && (result.available.live_balance ?? result.available.cash)) ?? null
    };

    return send(res, 200, normalized);
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
