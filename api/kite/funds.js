// api/kite/funds.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

/* -----------------------------------------
      EXTRACTORS FOR ZERODHA STRUCTURES
----------------------------------------- */

// Realised / utilised
function extractM2M(f) {
  try {
    if (f?.equity?.utilised?.m2m_realised != null) {
      return Number(f.equity.utilised.m2m_realised);
    }
    if (f?.equity?.utilised?.m2m_unrealised != null) {
      return Number(f.equity.utilised.m2m_unrealised);
    }
  } catch (e) {}

  return 0;
}

// Unrealised MTM = live today's PnL
function extractUnreal(f) {
  try {
    const net = Number(f?.equity?.net ?? 0);
    const opening = Number(f?.equity?.available?.opening_balance ?? 0);

    if (net && opening) {
      return net - opening; // Today’s MTM PnL
    }
  } catch (e) {}

  return 0;
}

// Account value / balance
function extractBalance(f) {
  try {
    if (f?.equity?.available?.live_balance != null)
      return Number(f.equity.available.live_balance);

    if (f?.equity?.net != null)
      return Number(f.equity.net);

    if (f?.equity?.available?.cash != null)
      return Number(f.equity.available.cash);
  } catch (e) {}

  return 0;
}

/* -----------------------------------------
                MAIN HANDLER
----------------------------------------- */

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    // Create kite client
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

    // Fetch margins/funds
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
      return send(res, 200, {
        ok: false,
        error: "Kite method failed",
        message: String(err)
      });
    }

    // Auto-detect structure
    let f = null;
    if (result?.funds) f = result.funds;
    else if (result?.equity || result?.commodity) f = result;
    else if (result?.data?.funds) f = result.data.funds;

    if (!f) {
      return send(res, 200, {
        ok: false,
        error: "Funds not available",
        result: result
      });
    }

    // Extract values
    const m2m = extractM2M(f);
    const unreal = extractUnreal(f);
    const bal = extractBalance(f);

    // --- PATCH: Write to KV state ---
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
      console.error("KV write error in /kite/funds:", e);
    }

    // Send normalized response
    return send(res, 200, {
      ok: true,
      funds: f,
      balance: bal,        // correct account value
      m2m_realised: m2m,   // realised PnL
      unrealised: unreal   // today's MTM PnL (net - opening_balance)
    });

  } catch (err) {
    return send(res, 500, {
      ok: false,
      error: err.message || String(err)
    });
  }
}
