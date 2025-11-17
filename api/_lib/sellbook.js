// api/_lib/sellbook.js
// Record sell orders to KV and compute consecutive "worsening" counts.
// Expects api/_lib/kv.js to export `kv` (with get/set) and `todayKey()`.

import { kv, todayKey } from "./kv.js";

export const SELLBOOK_KEY = (dateStr = null) => `sellbook:${dateStr || todayKey()}`;

/**
 * sellEntry shape:
 * {
 *   sr: Number,           // auto-increment serial no (1-based for this date key)
 *   tradeTs: Number,      // unix ms epoch when sell happened
 *   instrument: String,   // instrument token/symbol
 *   qty: Number,
 *   mtm: Number           // MTM value at the time of recording (positive or negative)
 * }
 */

/**
 * Append a sell entry to a day's sellbook and return the saved entry.
 * Uses safe retries to reduce race conditions.
 *
 * Options:
 *  - dateStr: YYYY-MM-DD (string) to write to a specific day's key
 *  - maxRetries: number
 */
export async function recordSellOrder(entry = {}, options = {}) {
  const dateStr = options.dateStr || null;
  const maxRetries = options.maxRetries || 3;
  const key = SELLBOOK_KEY(dateStr);

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      // read existing list
      const raw = await kv.get(key);
      const list = raw ? (typeof raw === "object" ? raw : JSON.parse(raw)) : [];

      const sr = list.length + 1;
      const nowEntry = {
        sr,
        tradeTs: entry.tradeTs || Date.now(),
        instrument: entry.instrument || entry.symbol || "unknown",
        qty: Number(entry.qty || 0),
        mtm: typeof entry.mtm === "number" ? entry.mtm : Number(entry.mtm || 0),
      };

      list.push(nowEntry);

      // persist back
      await kv.set(key, JSON.stringify(list));
      return nowEntry;
    } catch (err) {
      if (attempt === maxRetries) {
        console.error("recordSellOrder: final attempt failed", err && err.stack ? err.stack : err);
        throw err;
      }
      // small backoff before retry
      await new Promise((r) => setTimeout(r, 20 * attempt));
    }
  }

  throw new Error("recordSellOrder: exhausted retries");
}

/**
 * Get sell orders for a given date (YYYY-MM-DD) or today if omitted.
 * Returns an array (possibly empty).
 */
export async function getSellOrders(dateStr = null) {
  const key = SELLBOOK_KEY(dateStr);
  try {
    const raw = await kv.get(key);
    if (!raw) return [];
    if (typeof raw === "object") return raw;
    return JSON.parse(raw);
  } catch (e) {
    console.error("getSellOrders failed:", e && e.message ? e.message : e);
    return [];
  }
}

/**
 * Compute consecutive "worsening" events from a list of sell entries.
 *
 * RULES (per your final spec):
 * - Baseline (lastRecordedMtm) starts at 0.
 * - If current mtm === lastRecordedMtm -> part-fill -> no change.
 * - If current mtm < lastRecordedMtm -> worsened -> increment consecutive and set lastRecordedMtm = mtm.
 * - If current mtm > lastRecordedMtm -> improved -> reset consecutive to 0 and set lastRecordedMtm = mtm.
 * - The first entry is compared to baseline 0 (so a positive first mtm > 0 will NOT start the chain).
 *
 * Returns:
 * { lastSr, lastMtm, consecutiveCount, history }
 * where history entries are augmented with consecutiveAfter property.
 */
export function computeConsecutiveLossesFromList(list = []) {
  if (!Array.isArray(list) || list.length === 0) {
    return { lastSr: 0, lastMtm: 0, consecutiveCount: 0, history: [] };
  }

  let currentConsecutive = 0;
  let lastRecordedMtm = 0; // baseline is 0 (important)
  const history = [];

  for (const e of list) {
    const mtm = Number(e.mtm) || 0;

    if (mtm === lastRecordedMtm) {
      // part-fill (no change)
      // keep currentConsecutive and lastRecordedMtm as-is
    } else if (mtm < lastRecordedMtm) {
      // worsened -> increment count and update baseline
      currentConsecutive += 1;
      lastRecordedMtm = mtm;
    } else {
      // mtm > lastRecordedMtm -> improvement -> reset to 0 and update baseline
      currentConsecutive = 0;
      lastRecordedMtm = mtm;
    }

    history.push({ ...e, consecutiveAfter: currentConsecutive });
  }

  const last = list[list.length - 1];
  return {
    lastSr: last.sr,
    lastMtm: Number(last.mtm) || 0,
    consecutiveCount: currentConsecutive,
    history,
  };
}

/**
 * Convenience: compute consecutive stats for today's sellbook.
 */
export async function computeTodayConsecutive() {
  const list = await getSellOrders();
  return computeConsecutiveLossesFromList(list);
}

/**
 * Check today's consecutive count and, if >= threshold, call provided actionCallback.
 *
 * Options:
 * - threshold: number (default 3)
 * - actionCallback: async function(consecutiveCount, details) -> any
 *
 * Returns:
 * { triggered: boolean, count, result, error? }
 */
export async function checkAndTriggerActionIfNeeded(opts = {}) {
  const threshold = typeof opts.threshold === "number" ? opts.threshold : 3;
  const actionCallback = typeof opts.actionCallback === "function" ? opts.actionCallback : null;

  const res = await computeTodayConsecutive();
  const count = res.consecutiveCount || 0;

  if (count >= threshold && actionCallback) {
    try {
      await actionCallback(count, res);
      return { triggered: true, count, result: res };
    } catch (e) {
      console.error("checkAndTriggerActionIfNeeded: actionCallback failed", e && e.stack ? e.stack : e);
      return { triggered: false, count, result: res, error: e };
    }
  }

  return { triggered: false, count, result: res };
}

/**
 * Optional helper: clear today's sellbook (useful in tests)
 */
export async function clearSellBook(dateStr = null) {
  const key = SELLBOOK_KEY(dateStr);
  try {
    await kv.set(key, JSON.stringify([]));
    return true;
  } catch (e) {
    console.error("clearSellBook failed:", e && e.message ? e.message : e);
    return false;
  }
}

export default {
  SELLBOOK_KEY,
  recordSellOrder,
  getSellOrders,
  computeConsecutiveLossesFromList,
  computeTodayConsecutive,
  checkAndTriggerActionIfNeeded,
  clearSellBook,
};
