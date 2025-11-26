import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

// -------------------------------
// Extractors for Zerodha Structure
// -------------------------------

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

function extractBalance(f) {
  try {
    if (f?.equity?.available?.cash != null)
      return Number(f.equity.available.cash);

    if (f?.equity?.available?.live_balance != null)
      return Number(f.equity.available.live_balance);

    if (f?.equity?.net != null)
      return Number(f.equity.net);
  } catch (e) {}

  return 0;
}

// -------------------------------
// MAIN HANDLER
// -------------------------------

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
      } else if (typeof kc.getMargins === "function") {
        result = await kc.getMargins();
      } else {
        result = kc.funds || kc.balance || null;
      }
    } catch (err) {
      return send(res, 200, { ok: false, error: "Kite method failed", message: String(err) });
    }

   // Auto-detect Zerodha shape
let f = null;

// Shape 1: result.funds exists
if (result?.funds) {
  f = result.funds;
}
// Shape 2: result IS the funds object
else if (result?.equity || result?.commodity) {
  f = result;
}
// Shape 3: result.data.funds (rare)
else if (result?.data?.funds) {
  f = result.data.funds;
}

if (!f) {
  return send(res, 200, { ok:false, error:"Funds not available", result:result });
}


    // Extract values
    const m2m = extractM2M(f);
    const unreal = extractUnreal(f);
    const bal = extractBalance(f);

    // Write updated MTM to KV
    try {
      const key = `state:${todayKey()}`;
      const prev = (await kv.get(key)) || {};

      await kv.set(key, {
        ...prev,
        realised: m2m,
        unrealised: unreal,
        live_balance: bal,
        updated_at: Date.now()
      });
    } catch (e) {
      console.error("KV write error:", e);
    }

    // Response for UI
    return send(res, 200, {
      ok: true,
      funds: f,
      balance: bal,
      m2m_realised: m2m,
      unrealised: unreal
    });

  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
