// api/kite/trades.js
import { instance } from "../_lib/kite.js";
import { kv } from "../_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";
const LAST_SYNC_KEY = "guardian:tradebook:last_sync";
const IST = "Asia/Kolkata";

// Normalize Zerodha timestamp → numeric UTC ms
function normalizeTimestamp(ts) {
  if (!ts) return Date.now();

  // Zerodha returns: "2025-01-22 14:35:03"
  if (typeof ts === "string") {
    const parsed = Date.parse(ts.replace(" ", "T") + "Z");
    if (!isNaN(parsed)) return parsed;
  }

  // If timestamp is in seconds
  const n = Number(ts);
  if (!isNaN(n)) {
    return n < 2e10 ? n * 1000 : n;
  }

  return Date.now();
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const lastSync = await kv.get(LAST_SYNC_KEY);

    // Load KV tradebook
    let existing = (await kv.get(TRADEBOOK_KEY)) || [];
    if (!Array.isArray(existing)) existing = [];

   // Load existing sellbook
let sellbook = (await kv.get(SELLBOOK_KEY)) || [];
if (!Array.isArray(sellbook)) sellbook = [];

// --- NEW: Keep only today's sell entries ---
const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
sellbook = sellbook.filter(s => {
    const d = new Date(s.time_ms).toLocaleDateString("en-IN", { timeZone: IST });
    return d === todayIST;
});


    // Sync only every 20 sec
    const shouldSync = !lastSync || now - lastSync > 20000;

    if (shouldSync) {
      let kc;

      try {
        kc = await instance();
      } catch (err) {
        return res.status(200).json({
          ok: true,
          synced: false,
          reason: "Kite session expired",
          trades: existing,
          sellbook
        });
      }

      // Fetch Zerodha trades
      let zerodhaTrades = [];
      try {
        const resp = await kc.getTrades();
        zerodhaTrades = resp?.data || resp || [];
      } catch (err) {
        return res.status(200).json({
          ok: false,
          synced: false,
          reason: "Failed to fetch Zerodha trades",
          error: String(err),
          trades: existing,
          sellbook
        });
      }

      // Deduplicate: Map<trade_id, trade>
      const map = new Map(existing.map(t => [t.trade_id, t]));

      for (const t of zerodhaTrades) {
        if (!t.trade_id) continue;

        // USE REAL EXCHANGE TIMESTAMP
        const ts = normalizeTimestamp(t.exchange_timestamp);

        map.set(t.trade_id, {
          trade_id: t.trade_id,
          order_id: t.order_id,
          tradingsymbol: t.tradingsymbol,
          exchange: t.exchange,
          side: t.transaction_type, // BUY or SELL
          product: t.product,
          qty: t.quantity,
          price: t.average_price,
          ts,
          iso: new Date(ts).toISOString()
        });
      }

      // Map → Array
      let merged = Array.from(map.values());

      // Keep today's trades only
      const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });

      merged = merged.filter(t => {
        const d = new Date(t.ts).toLocaleDateString("en-IN", { timeZone: IST });
        return d === todayIST;
      });

      // Sort newest first
      merged.sort((a, b) => b.ts - a.ts);

      // ---------------------------
      // BUILD SELLBOOK (SELL ONLY)
      // ---------------------------
      const mtmObj = await kv.get("live:mtm");
      const liveMTM = Number(mtmObj?.total ?? mtmObj?.mtm ?? 0);

      for (const t of merged) {
        if (t.side !== "SELL") continue;

        // Skip if already inserted
        if (sellbook.some(s => s.trade_id === t.trade_id)) continue;

        const prev = sellbook.length > 0 ? sellbook[sellbook.length - 1] : null;
        const prevMTM = prev ? Number(prev.mtm) : 0;

        sellbook.push({
          instrument: t.tradingsymbol,
          qty: t.qty,
          price: t.price,
          mtm: liveMTM,
          mtm_change: liveMTM - prevMTM,
          trade_id: t.trade_id,
          time_ms: t.ts,
        });
      }

      // Sort sellbook newest first
      sellbook.sort((a, b) => a.time_ms - b.time_ms);

      // Save both books
      await kv.set(TRADEBOOK_KEY, merged);
      await kv.set(SELLBOOK_KEY, sellbook);
      await kv.set(LAST_SYNC_KEY, now);

      return res.status(200).json({
        ok: true,
        synced: true,
        trades: merged,
        sellbook
      });
    }

    // No sync → return cached KV
    return res.status(200).json({
      ok: true,
      synced: false,
      trades: existing,
      sellbook
    });

  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
