// api/tradebook.js
import { instance } from "./_lib/kite.js";
import { kv } from "./_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const LAST_SYNC_KEY = "guardian:tradebook:last_sync";
const IST = "Asia/Kolkata";

// Parse timestamp from Zerodha or stored trade
function normalizeTimestamp(ts) {
  if (!ts) return Date.now();
  const n = Number(ts);
  if (!isNaN(n)) {
    return String(n).length === 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? Date.now() : parsed;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const lastSync = await kv.get(LAST_SYNC_KEY);

    // 1️⃣ LOAD EXISTING TRADEBOOK FIRST
    let existing = (await kv.get(TRADEBOOK_KEY)) || [];
    if (!Array.isArray(existing)) existing = [];

    // 2️⃣ CHECK STALE DATA (sync only every 20 seconds)
    const shouldSync = !lastSync || now - lastSync > 20_000;

    if (shouldSync) {
      let kc = null;

      try {
        kc = await instance();
      } catch (e) {
        // If session expired → return existing KV to UI
        return res.status(200).json({
          ok: true,
          synced: false,
          reason: "Kite session expired",
          trades: existing
        });
      }

      // 3️⃣ FETCH EXECUTED TRADES FROM ZERODHA
      let trades = [];
      try {
        const resp = await kc.getTrades();
        trades = resp?.data || resp || [];
      } catch (err) {
        // Return existing KV (UI will still work)
        return res.status(200).json({
          ok: false,
          synced: false,
          reason: "Zerodha trades fetch failed",
          error: String(err),
          trades: existing
        });
      }

      // 4️⃣ MERGE TRADES (DEDUPE)
      const map = new Map(existing.map(t => [t.trade_id, t]));

      for (const t of trades) {
        if (!t.trade_id) continue;

        map.set(t.trade_id, {
          trade_id: t.trade_id,
          order_id: t.order_id,
          tradingsymbol: t.tradingsymbol,
          exchange: t.exchange,
          side: t.transaction_type, 
          product: t.product,
          qty: t.quantity,
          price: t.average_price,
          ts: normalizeTimestamp(t.timestamp),
          iso: new Date(normalizeTimestamp(t.timestamp)).toISOString()
        });
      }

      // 5️⃣ CONVERT MAP → ARRAY
      let merged = Array.from(map.values());

      // 6️⃣ KEEP ONLY TODAY'S TRADES
      const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
      merged = merged.filter(t => {
        const d = new Date(t.ts).toLocaleDateString("en-IN", { timeZone: IST });
        return d === todayIST;
      });

      // 7️⃣ SORT LATEST FIRST
      merged.sort((a, b) => b.ts - a.ts);

      // 8️⃣ SAVE TO KV
      await kv.set(TRADEBOOK_KEY, merged);
      await kv.set(LAST_SYNC_KEY, now);

      return res.status(200).json({
        ok: true,
        synced: true,
        trades: merged
      });
    }

    // 9️⃣ IF RECENT KV → RETURN WITHOUT SYNC
    return res.status(200).json({
      ok: true,
      synced: false,
      trades: existing
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
