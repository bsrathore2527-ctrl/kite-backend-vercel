
// api/kite/funds.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

function send(res, code, body = {}) {
  return res.status(code).setHeader("Cache-Control", "no-store").json(body);
}

function extractM2M(result) {
  // try several common shapes to find m2m_realised / m2m_unrealised / net mtm
  try {
    if (result?.funds?.equity?.utilised && typeof result.funds.equity.utilised.m2m_realised !== "undefined") {
      return Number(result.funds.equity.utilised.m2m_realised || 0);
    }
    if (result?.funds?.equity?.utilised && typeof result.funds.equity.utilised.m2m_unrealised !== "undefined") {
      return Number(result.funds.equity.utilised.m2m_unrealised || 0);
    }
    if (typeof result.m2m_realised !== "undefined") return Number(result.m2m_realised || 0);
    if (typeof result.m2m_unrealised !== "undefined") return Number(result.m2m_unrealised || 0);
    // try top-level used fields
    if (result?.utilised && typeof result.utilised.m2m_realised !== "undefined") return Number(result.utilised.m2m_realised || 0);
    // fallback: try a net field (some libs use .net for PnL)
    if (typeof result.net !== "undefined") return Number(result.net || 0);
  } catch (e) {
    // ignore
  }
  return null;
}

function extractUnreal(result) {
  try {
    // prefer funds.available.live_balance or funds.equity.net or explicit m2m_unrealised
    if (result?.funds?.equity && typeof result.funds.equity.net !== "undefined") return Number(result.funds.equity.net || 0);
    if (result?.funds?.equity?.utilised && typeof result.funds.equity.utilised.m2m_unrealised !== "undefined") return Number(result.funds.equity.utilised.m2m_unrealised || 0);
    if (result?.funds?.available && typeof result.funds.available.live_balance !== "undefined") return Number(result.funds.available.live_balance || 0);
    if (typeof result.balance !== "undefined") return Number(result.balance || 0);
  } catch (e) {}
  return null;
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
      if (typeof kc.getFunds === "function") {
        result = await kc.getFunds();
      } else if (typeof kc.get_funds === "function") {
        result = await kc.get_funds();
      } else if (typeof kc.getMargins === "function") {
        result = await kc.getMargins();
      } else if (typeof kc.getProfile === "function") {
        const prof = await kc.getProfile();
        result = { balance: prof?.balance ?? null, profile: prof };
      } else {
        result = kc.funds || kc.balance || null;
      }
    } catch (err) {
      return send(res, 200, { ok: false, error: "Kite method failed", message: String(err) });
    }

    if (!result) {
      return send(res, 200, { ok: false, error: "Kite connected but funds not available", result: null });
    }

    // Normalize a small payload the UI expects
    const m2m_realised = extractM2M(result);
    const unreal = extractUnreal(result);

    const normalized = {
      ok: true,
      funds: result,
      balance: result.balance ?? (result.available && (result.available.live_balance ?? result.available.cash)) ?? null,
      // extras for UI / server logic:
      m2m_realised: m2m_realised,
      unrealised: unreal
    };
// --- PATCH: Save latest MTM & balance to KV ---
try {
  const key = `state:${todayKey()}`;
  const prev = (await kv.get(key)) || {};

  await kv.set(key, {
    ...prev,
    realised: m2m_realised,
    unrealised: unreal,
    live_balance: normalized.balance,
    updated_at: Date.now()
  });
} catch (e) {
  console.error("KV write error in /kite/funds:", e);
}

    return send(res, 200, normalized);
  } catch (err) {
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
