// api/kite/funds.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

/* -----------------------------------------
        MTM + FUNDS HELPERS
----------------------------------------- */

// Zerodha realised MTM
function extractM2M(f) {
  try {
    if (f?.equity?.utilised?.m2m_realised != null)
      return Number(f.equity.utilised.m2m_realised);

    if (f?.equity?.utilised?.m2m_unrealised != null)
      return Number(f.equity.utilised.m2m_unrealised);
  } catch (e) {}

  return 0;
}

// Zerodha unrealised P&L based on net - opening balance
function extractUnreal(f) {
  try {
    const net = Number(f?.equity?.net ?? 0);
    const opening = Number(f?.equity?.available?.opening_balance ?? 0);
    if (net && opening) return net - opening;
  } catch (e) {}
  return 0;
}

// Account balance extractor
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
   MAIN HANDLER (MERGED WITH POSITIONS-MTM)
----------------------------------------- */

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return send(res, 405, { ok: false, error: "Method not allowed" });
    }

    // Create kite instance
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

    /* -----------------------------------------
           1) FETCH FUNDS / MARGINS
    ----------------------------------------- */
    let result = null;
    try {
      if (typeof kc.getFunds === "function") result = await kc.getFunds();
      else if (typeof kc.get_funds === "function") result = await kc.get_funds();
      else if (typeof kc.getMargins === "function") result = await kc.getMargins();
      else result = kc.funds || kc.balance || null;
    } catch (err) {
      return send(res, 200, {
        ok: false,
        error: "Kite method failed",
        message: String(err)
      });
    }

    let f = null;
    if (result?.funds) f = result.funds;
    else if (result?.equity || result?.commodity) f = result;
    else if (result?.data?.funds) f = result.data.funds;

    if (!f) {
      return send(res, 200, { ok: false, error: "Funds not available", result });
    }

    const m2m_funds = extractM2M(f);
    const unreal_funds = extractUnreal(f);
    const balance = extractBalance(f);

    /* -----------------------------------------
           2) FETCH POSITIONS FOR ACCURATE MTM
    ----------------------------------------- */
    let pos = null;
    try {
      pos = await kc.getPositions();
    } catch (e) {
      pos = null;
    }

    let totalUnreal = unreal_funds;
    let totalReal = m2m_funds;

    if (pos?.data?.net || pos?.net) {
      const net = pos.data?.net || pos.net || [];
      totalReal = 0;
      totalUnreal = 0;

      for (const p of net) {
        const u = Number(p.unrealised || 0);
        const r = Number(p.realised || 0);
        totalUnreal += u;
        totalReal += r;
      }
    }

    const totalPnl = totalReal + totalUnreal;

    /* -----------------------------------------
          3) WRITE MTM TO KV (STATE + LIVE)
    ----------------------------------------- */
    const key = `state:${todayKey()}`;
    const prev = (await kv.get(key)) || {};

    await kv.set(key, {
      ...prev,
      realised: totalReal,
      unrealised: totalUnreal,
      total_pnl: totalPnl,
      live_balance: balance,
      updated_at: Date.now()
    });

    await kv.set("live:mtm", {
      realised: totalReal,
      unrealised: totalUnreal,
      total: totalPnl,
      mtm: totalPnl,
      updated_at: Date.now()
    });

    /* -----------------------------------------
                4) RETURN RESPONSE
    ----------------------------------------- */
    return send(res, 200, {
      ok: true,
      balance,
      realised: totalReal,
      unrealised: totalUnreal,
      total_pnl: totalPnl,
      funds: f,
      positions_used: !!pos,
      merged_mtm: true
    });

  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
