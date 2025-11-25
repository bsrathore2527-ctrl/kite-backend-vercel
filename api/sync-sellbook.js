// api/sync-sellbook.js
// This version groups SELL trades by order_id (same logic as tradebook)
// Fixes timestamp (IST), fixes partial fills, keeps MTM + change intact.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";

const SELLBOOK_KEY = "guardian:sell_orders";
const TRADEBOOK_KEY = "guardian:tradebook";

// Convert timestamp to ms
function getTimestampMs(t) {
  const ts =
    t._ts ||
    t.trade_time ||
    t.timestamp ||
    t.exchange_timestamp ||
    t.order_timestamp ||
    t.created_at;

  if (!ts) return Date.now();

  if (typeof ts === "number") {
    if (String(ts).length === 10) return ts * 1000; // seconds → ms
    return ts;
  }

  const parsed = Date.parse(ts);
  return Number.isNaN(parsed) ? Date.now() : parsed;
}

// IST date string YYYY-MM-DD
function getISTDate(ms) {
  return new Date(ms).toLocaleDateString("en-IN", {
    timeZone: "Asia/Kolkata"
  });
}

export default async function handler(req, res) {
  try {
    // 1. Load KV tradebook
    const raw = await kv.get(TRADEBOOK_KEY);
    let trades = [];
    try {
      trades = JSON.parse(raw || "[]");
    } catch {
      trades = [];
    }

    if (!Array.isArray(trades)) trades = [];

    // 2. Get today's IST date
    const now = Date.now();
    const todayIST = getISTDate(now);

    // 3. Load current MTM (used for mtm + mtm_change)
    let liveState = null;
    try {
      const s = await kv.get("guardian:state");
      liveState = JSON.parse(s || "{}");
    } catch {}
    const currentMTM = Number(liveState?.total_pnl || 0);

    // 4. GROUP SELL TRADES BY ORDER ID (same as tradebook)
    const groupedMap = new Map();

    for (const t of trades) {
      const side = (t.side || t.transaction_type || "").toUpperCase();
      if (side !== "SELL") continue;

      const orderId =
        t.order_id || t.orderid || t.trade_id || t.order || "UNKNOWN";

      const qty = Number(t.qty || t.quantity || 0);
      const price = Number(t.price || t.average_price || 0);

      const ts = getTimestampMs(t);

      if (!groupedMap.has(orderId)) {
        groupedMap.set(orderId, {
          order_id: orderId,
          instrument: t.tradingsymbol || t.symbol,
          qty,
          weighted_sum: qty * price,
          last_ts: ts
        });
      } else {
        const g = groupedMap.get(orderId);
        g.qty += qty;
        g.weighted_sum += qty * price;
        if (ts > g.last_ts) g.last_ts = ts; // keep latest fill timestamp
      }
    }

    // 5. Convert grouped map → final grouped sell entries
    const groupedSells = Array.from(groupedMap.values()).map((g) => ({
      order_id: g.order_id,
      instrument: g.instrument,
      qty: g.qty,
      price: g.qty ? g.weighted_sum / g.qty : 0,
      time_ms: g.last_ts,
      iso: new Date(g.last_ts).toLocaleString("en-IN", {
        timeZone: "Asia/Kolkata"
      })
    }));

    // 6. Load existing sellbook from KV
    let sellArr = [];
    try {
      const s = await kv.get(SELLBOOK_KEY);
      sellArr = JSON.parse(s || "[]");
    } catch {
      sellArr = [];
    }
    if (!Array.isArray(sellArr)) sellArr = [];

    // 7. Append only today's grouped SELL entries
    for (const g of groupedSells) {
      const tradeDateIST = getISTDate(g.time_ms);
      if (tradeDateIST !== todayIST) continue;

      // Avoid duplicates
      const exists = sellArr.some((x) => x.trade_id === g.order_id);
      if (exists) continue;

      const last = sellArr.length > 0 ? sellArr[sellArr.length - 1] : null;
      const lastMtm = last ? Number(last.mtm) : 0;

      sellArr.push({
        instrument: g.instrument,
        qty: g.qty,
        price: Number(g.price),
        mtm: currentMTM,
        mtm_change: currentMTM - lastMtm,
        trade_id: g.order_id,
        time_ms: g.time_ms,
        iso: g.iso
      });
    }

    // 8. Save updated sellbook
    await kv.set(SELLBOOK_KEY, JSON.stringify(sellArr));

    return res.status(200).json({
      ok: true,
      count: sellArr.length,
      sellbook: sellArr
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
