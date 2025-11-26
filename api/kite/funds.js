// api/kite/funds.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

/* ------------------------------
   FIXED extract functions
------------------------------ */
function extractM2M(f) {
  try {
    if (f?.equity?.utilised?.m2m_realised != null)
      return Number(f.equity.utilised.m2m_realised);

    if (f?.equity?.utilised?.m2m_unrealised != null)
      return Number(f.equity.utilised.m2m_unrealised);
  } catch (e) {}

  return 0;
}

function extractUnreal(f) {
  try {
    if (f?.equity?.available?.live_balance != null)
      return Number(f.equity.available.live_balance);

    if (f?.equity?.net != null)
      return Number(f.equity.net);
  } catch (e) {}

  return 0;
}

/* ------------------------------
   MAIN HANDLER
------------------------------ */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    let kc;
    try {
      kc = await instance();
    } catch (e) {
      const cached = (await kv.get(`state:${todayKey()}`)) || {};
      return send(res, 200, {
        ok: false,
        error: "Kite not connected",
        message: String(e),
        fallback_state: cached
      });
    }

    let result = null;
    try {
      if (typeof kc.getFunds === "function") {
        result = await kc.getFunds();
      } else if (typeof kc.get_funds === "function") {
        result = await kc.get_funds();
      } else if (typeof kc.getMargins === "function") {
        result = await kc.getMargins();
      } else {
        result = kc.funds || kc.balance || null;
      }
    } catch (err) {
      return send(res, 200, { ok: false, error: "Kite method failed", message: String(err) });
    }

    if (!result?.funds) {
      return send(res, 200, { ok: false, error: "Funds not available", result: null });
    }

    // Extract ONLY from result.funds (correct place)
    const f = result.funds;

    const m2m = extractM2M(f);
    const unreal = extractUnreal(f);

    const normalized = {
      ok: true,
      funds: f,
      balance: f.equity?.available?.cash ?? f.equity?.available?.live_balance ?? null,
      m2m_realised: m2m,
      unrealised: unreal
    };

    return send(res, 200, normalized);

  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
