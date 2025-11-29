// ======================================================================
// MULTI-USER STATE.JS (FINAL VERSION)
// - Returns full merged state for admin.html
// - Read-only endpoint
// - No enforcement logic
// - Uses Upstash KV + getClientId()
// ======================================================================

import { kv } from "./_lib/kv.js";
import { getClientId } from "./kite.js";

export default async function handler(req) {
  try {
    const userId = await getClientId();
    if (!userId) {
      return json({ ok: false, error: "No userId found" });
    }

    // ----------------------------------------------------------
    // KV KEYS
    // ----------------------------------------------------------
    const stateKey = `state:${userId}`;
    const configKey = `config:${userId}`;
    const posKey = `positions:${userId}`;
    const tradebookKey = `tradebook:${userId}`;
    const watchKey = `watchlist:${userId}`;
    const mtmKey = `mtm:${userId}`;

    // ----------------------------------------------------------
    // FETCH ALL DATA
    // ----------------------------------------------------------
    const [
      state,
      config,
      positions,
      tradebook,
      watchlist,
      rawMTM
    ] = await Promise.all([
      kv.get(stateKey),
      kv.get(configKey),
      kv.get(posKey),
      kv.get(tradebookKey),
      kv.get(watchKey),
      kv.get(mtmKey)
    ]);

    const currentMTM = Number(rawMTM || 0);

    // ----------------------------------------------------------
    // PREPARE RETURN OBJECT
    // ----------------------------------------------------------
    const out = {
      ok: true,
      userId,
      mtm: currentMTM,

      // State defaults
      state: {
        tripped_day: state?.tripped_day || false,
        trip_reason: state?.trip_reason || null,
        consecutive_losses: Number(state?.consecutive_losses || 0),
        last_trade_mtm: Number(state?.last_trade_mtm || 0),
        remaining_to_max_loss: Number(state?.remaining_to_max_loss || 0),
        unrealised: currentMTM,
        total_pnl: currentMTM,
        last_update_ts: state?.last_update_ts || 0,
        ...state
      },

      // Config defaults
      config: config || {},

      positions: positions || [],
      tradebook: tradebook || {},
      watchlist: watchlist || []
    };

    return json(out);

  } catch (err) {
    return json({ ok: false, error: err.message || String(err) });
  }
}

// --------------------------------------------------------------
// Helper: JSON response
// --------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
