// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getLiveM2M } from "../state.js"; // MTM fetch

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

// ---------------------- UTILS -----------------------

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function toNumberOrNull(v) {
  if (v === null || typeof v === "undefined") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTsToMs(ts) {
  if (ts === null || typeof ts === "undefined") return null;
  if (typeof ts === "number") {
    if (String(Math.trunc(ts)).length === 10) return ts * 1000;
    return ts;
  }
  if (/^\d+$/.test(String(ts).trim())) {
    const n = Number(ts);
    if (String(Math.trunc(n)).length === 10) return n * 1000;
    return n;
  }
  const parsed = Date.parse(String(ts));
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function normalizeTrade(t) {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };

  const candidates = [
    out.avg_price,
    out.average_price,
    out.trade_price,
    out.price,
    out.last_price,
  ];

  let price = null;
  for (const c of candidates) {
    const p = toNumberOrNull(c);
    if (p !== null && p !== 0) { price = p; break; }
  }
  out.price_normalized = price;

  const possibleTs =
    out._ts ||
    out.trade_time ||
    out.timestamp ||
    out.exchange_timestamp ||
    out.order_timestamp ||
    out.created_at ||
    out.ts;

  const ms = normalizeTsToMs(possibleTs);
  out._ts = ms || out._ts || null;
  out._iso = out._ts ? new Date(out._ts).toISOString() : null;

  return out;
}

// ---------------- GROUPING MULTI-FILLS ----------------

function groupTradesByOrderId(trades) {
  const map = new Map();

  for (const t of trades) {
    const oid = t.order_id || t.orderid || t.order || "UNKNOWN";

    if (!map.has(oid)) {
      map.set(oid, {
        order_id: oid,
        tradingsymbol: t.tradingsymbol,
        transaction_type: t.transaction_type,
        quantity: Number(t.quantity) || 0,
        weighted_price_sum: (Number(t.price_normalized) || 0) * (Number(t.quantity) || 0),
        _ts: t._ts,
        _iso: t._iso,
      });
    } else {
      const existing = map.get(oid);
      const qty = Number(t.quantity) || 0;
      const px = Number(t.price_normalized) || 0;

      existing.quantity += qty;
      existing.weighted_price_sum += qty * px;

      // Use last timestamp
      if (t._ts > existing._ts) {
        existing._ts = t._ts;
        existing._iso = t._iso;
      }
    }
  }

  return Array.from(map.values()).map(t => {
    t.avg_price = t.quantity
      ? t.weighted_price_sum / t.quantity
      : null;
    delete t.weighted_price_sum;
    return t;
  });
}

// ---------------- STORE SELL ORDER -------------------

async function storeSellOrder(trade) {
  try {
    const raw = await kv.get(SELLBOOK_KEY);
    let sellOrders = [];

    try { sellOrders = JSON.parse(raw || "[]"); }
    catch { sellOrders = []; }

    // Avoid duplicates
    const exists = sellOrders.some(e =>
      e.order_id === trade.order_id ||
      e.time === trade.exchange_timestamp
    );
    if (exists) return;

    const mtm = await getLiveM2M();
    const last = sellOrders[sellOrders.length - 1];
    const change = last ? mtm - last.mtm : 0;

    const entry = {
      order_id: trade.order_id,
      instrument: trade.tradingsymbol,
      time: trade.exchange_timestamp || new Date().toISOString(),
      mtm,
      change,
    };

    sellOrders.push(entry);
    await kv.set(SELLBOOK_KEY, JSON.stringify(sellOrders));
  } catch (err) {
    console.error("storeSellOrder error:", err);
  }
}

// ------------------- MAIN HANDLER ---------------------

export default async function handler(req, res) {
  try {
    // 1) ADMIN RAW VIEW
    if (isAdmin(req) && req.query && req.query.raw === "1") {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      try {
        const arr = JSON.parse(raw);
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: arr });
      } catch {
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: [] });
      }
    }

    // 2) PERSISTED KV TRADEBOOK
    try {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      let arr = [];
      try { arr = JSON.parse(raw); }
      catch { arr = []; }

      if (Array.isArray(arr) && arr.length) {
        const normalized = arr.slice(-200).map(normalizeTrade);
        const grouped = groupTradesByOrderId(normalized);
        return res.status(200).json({ ok: true, source: "kv", trades: grouped });
      }
    } catch (e) {
      console.warn("kite/trades kv read failed:", e?.message || e);
    }

    // 3) LIVE KITE FALLBACK
    try {
      const kc = await instance();
      const trades = (await kc.getTrades()) || [];

      if (trades.length) {
        const normalized = trades.slice(-200).map(normalizeTrade);
        const grouped = groupTradesByOrderId(normalized);

        // SAVE SELL ORDERS BASED ON RAW TRADES (not grouped)
        for (const t of trades) {
          if (t.transaction_type === "SELL") {
            await storeSellOrder(t);
          }
        }

        return res.status(200).json({ ok: true, source: "kite", trades: grouped });
      }
    } catch (e) {
      console.warn("kite/trades fallback failed:", e?.message || e);
    }

    return res.status(200).json({ ok: true, source: "empty", trades: [] });

  } catch (err) {
    console.error("kite/trades error:", err?.stack || err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
