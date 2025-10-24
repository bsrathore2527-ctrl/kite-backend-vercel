// api/_lib/admin-utils.js
// Utilities used by admin endpoints and trade processing
import { kv, todayKey } from "./kv.js";

/**
 * updateConsecutiveLossesOnRealised(realised, tradeId = null)
 * - realised: number (positive profit, negative loss)
 * - tradeId: optional unique id for the trade/fill (used to avoid double-counting)
 *
 * Persisted keys:
 *   - risk:{YYYY-MM-DD}         -> main state object
 *   - risk:{YYYY-MM-DD}:processed_fills -> object to track processed tradeIds
 */
export async function updateConsecutiveLossesOnRealised(realised, tradeId = null) {
  const dateKey = todayKey();
  const key = `risk:${dateKey}`;

  // guard: if tradeId provided, check processed map
  if (tradeId) {
    const processedKey = `risk:${dateKey}:processed_fills`;
    const processed = (await kv.get(processedKey)) || {};
    if (processed[tradeId]) {
      // already processed
      return { ok: true, note: "already_processed", consecutive_losses: (await kv.get(key))?.consecutive_losses ?? 0 };
    }
    // mark processed
    processed[tradeId] = true;
    await kv.set(processedKey, processed);
  }

  const state = (await kv.get(key)) || {};

  let consecutive = Number(state.consecutive_losses || 0);

  if (Number(realised) < 0) {
    consecutive = consecutive + 1;
  } else if (Number(realised) > 0) {
    consecutive = 0;
  } // if zero: leave as-is

  const nextState = {
    ...state,
    realised: (Number(state.realised || 0) + Number(realised || 0)),
    consecutive_losses: consecutive
  };

  await kv.set(key, nextState);

  return { ok: true, consecutive_losses: consecutive, state: nextState };
}

/**
 * small helper to require admin in handlers
 */
export function checkAdmin(req, adminToken) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : a;
  return !!adminToken && token === adminToken;
}
