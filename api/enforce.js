// ======================================================================
// MULTI-USER ENFORCE.JS (FINAL VERSION)
// - Fallback risk checker ONLY
// - No square-off logic here (OPTION A)
// - Does NOT cancel pending or square-off positions
// - Reads state:<uid> and mtm:<uid>
// - Ensures state is consistent and returns it
// ======================================================================

import { kv } from "./_lib/kv.js";
import { getClientId } from "./_lib/kite.js";

export default async function handler(req) {
  try {
    const userId = await getClientId();
    if (!userId) {
      return json({ ok: false, error: "No userId found" });
    }

    // ----------------------------------------------------------
    // KEYS
    // ----------------------------------------------------------
    const stateKey = `state:${userId}`;
    const configKey = `config:${userId}`;
    const mtmKey = `mtm:${userId}`;

    // ----------------------------------------------------------
    // LOAD KV VALUES
    // ----------------------------------------------------------
    const state = (await kv.get(stateKey)) || {};
    const config = (await kv.get(configKey)) || {};
    const rawMTM = await kv.get(mtmKey);
    const currentMTM = Number(rawMTM || 0);

    // ----------------------------------------------------------
    // ENSURE STATE FIELDS EXIST
    // ----------------------------------------------------------
    const nextState = {
      tripped_day: state.tripped_day || false,
      trip_reason: state.trip_reason || null,
      consecutive_losses: Number(state.consecutive_losses || 0),
      last_trade_mtm: Number(state.last_trade_mtm || 0),
      unrealised: currentMTM,
      total_pnl: currentMTM,
      remaining_to_max_loss: Number(state.remaining_to_max_loss || 0),
      last_update_ts: Date.now(),
      ...state   // merge other fields
    };

    // ----------------------------------------------------------
    // WRITE FINAL STATE BACK (minor correction only)
    // ----------------------------------------------------------
    await kv.set(stateKey, nextState);

    // ----------------------------------------------------------
    // RESPOND (fallback mode)
    // ----------------------------------------------------------
    return json({
      ok: true,
      mode: "fallback",
      tripped: nextState.tripped_day,
      tripReason: nextState.trip_reason,
      state: nextState,
      config
    });

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
