// ======================================================================
// MULTI-USER GUARDIAN.JS (FINAL VERSION)
// - Pure read-only data provider for admin UI
// - No squareoff, no cancel, no risk execution
// - Combines all user KV data into a single clean response
// ======================================================================

import { kv } from "./_lib/kv.js";
import { getClientId } from "../kite.js";

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
    // ENSURE SAFE OBJECT STRUCTURES
    // ----------------------------------------------------------
    const finalData = {
      ok: true,
      userId,
      mtm: currentMTM,
      state: state || {},
      config: config || {},
      positions: positions || [],
      tradebook: tradebook || {},
      watchlist: watchlist || []
    };

    return json(finalData);

  } catch (err) {
    return json({ ok: false, error: err.message || String(err) });
  }
}

// --------------------------------------------------------------
// JSON helper
// --------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      "Content-Type": "application/json"
    }
  });
}
