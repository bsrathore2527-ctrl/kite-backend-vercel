// api/kite/trades.js
import { instance } from "../_lib/kite.js";
import { kv } from "../_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";
const LAST_SYNC_KEY = "guardian:tradebook:last_sync";
const IST = "Asia/Kolkata";

// Convert Zerodha timestamp → numeric UTC ms
function normalizeTimestamp(ts) {
  if (!ts) return Date.now();
  const n = Number(ts);
  if (!isNaN(n)) return (String(n).length === 10 ? n * 1000 : n);
  const parsed = Date.parse(ts);
  return isNaN(parsed) ? Date.now() : parsed;
}

export default async function handler(req, res) {
  try {
    const now = Date.now();
    const lastSync = await kv.get(LAST_SYNC_KEY);

    // Load KV
    let existing = (await kv.get(TRADEBOOK_KEY)) || [];
    if (!Array.isArray(existing)) existing = [];

    let sellbook = (await kv.get(SELLBOOK_KEY)) || [];
    if (!Array.isArray(sellbook)) sellbook = [];

    // Sync window: Only fetch Zerodha trades every 20 seconds
    const shouldSync = !lastSync || now - lastSync > 20000;

    if (shouldSync) {
      let kc;

      try {
        kc = await instance();
      } catch (err) {
        // Kite session expired → return cached KV
        return res.status(200).json({
          ok: true,
          synced: false,
          reason: "Kite session expired",
          trades: existing,
          sellbook
        });
      }

      // Fetch executed trades
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

      // Deduplicate using Map
      const map = new Map(existing.map(t => [t.trade_id, t]));

      for (const t of zerodhaTrades) {
        if (!t.trade_id) continue;

        map.set(t.trade_id, {
          trade_id: t.trade_id,
          order_id: t.order_id,
          tradingsymbol: t.tradingsymbol,
          exchange: t.exchange,
          side: t.transaction_type, // BUY / SELL
          product: t.product,
          qty: t.quantity,
          price: t.average_price,
          ts: normalizeTimestamp(t.timestamp),
          iso: new Date(normalizeTimestamp(t.timestamp)).toISOString()
        });
      }

      // Convert map → array
      let merged = Array.from(map.values());

      // Keep today's trades only
      const todayIST = new Date().toLocaleDateString("en-IN", { timeZone: IST });
      merged = merged.filter(t => {
        const d = new Date(t.ts).toLocaleDateString("en-IN", { timeZone: IST });
        return d === todayIST;
      });

      // Sort newest first
      merged.sort((a, b) => b.ts - a.ts);

      // -------------------------
      // SELLBOOK BUILDER
      // -------------------------
      const mtmObj = await kv.get("live:mtm");
      const liveMTM = Number(mtmObj?.total ?? mtmObj?.mtm ?? 0);

      for (const t of merged) {
        if (t.side !== "SELL") continue;

        // Prevent duplicate sell entries
        const exists = sellbook.find(s => s.trade_id === t.trade_id);
        if (exists) continue;

        const last = sellbook.length > 0 ? sellbook[sellbook.length - 1] : null;
        const lastMtm = last ? Number(last.mtm) : 0;

        sellbook.push({
          instrument: t.tradingsymbol,
          qty: t.qty,
          price: t.price,
          mtm: liveMTM,
          mtm_change: liveMTM - lastMtm,
          trade_id: t.trade_id,
          time_ms: t.ts,
          iso: t.iso
        });
      }

      // Sort sellbook newest first
      sellbook.sort((a, b) => b.time_ms - a.time_ms);

      // Save both tradebook + sellbook
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

    // No sync needed → return cached KV
    return res.status(200).json({
      ok: true,
      synced: false,
      trades: existing,
      sellbook
    });

  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
