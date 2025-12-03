// ===========================================================
//                TRADES ENDPOINT (FULLY FIXED)
// ===========================================================

import kv from "./kv.js";          // ✅ your real KV
import KiteConnect from "kiteconnect";

const TRADEBOOK_KEY = "guardian:tradebook";

// Normalize Zerodha trade
function normalizeTrade(t) {
  return {
    ts: new Date(t.exchange_timestamp || t.fill_timestamp).getTime(),
    iso_date: t.exchange_timestamp || t.fill_timestamp || null,
    tradingsymbol: t.tradingsymbol,
    account_id: t.account_id || null,
    trade_id: t.trade_id,
    side: t.transaction_type,
    qty: t.quantity,
    price: t.average_price || 0,
    raw: t,
    _ts: new Date(t.exchange_timestamp || t.fill_timestamp).getTime(),
    _iso: t.exchange_timestamp || t.fill_timestamp || null,
  };
}

// Group by order_id
function groupTradesByOrderId(normTrades) {
  const map = new Map();
  for (const t of normTrades) {
    const oid = t.raw.order_id || "unknown";
    if (!map.has(oid)) map.set(oid, []);
    map.get(oid).push(t);
  }
  return Object.fromEntries(map.entries());
}

// Save SELL trades
async function storeSellOrder(t) {
  try {
    const key = `guardian:sell:${t.order_id}`;
    await kv.set(key, {
      ts: Date.now(),
      order_id: t.order_id,
      traded_quantity: t.quantity,
      average_price: t.average_price,
      instrument_token: t.instrument_token,
      side: t.transaction_type,
      tradingsymbol: t.tradingsymbol,
    });
  } catch (err) {
    console.log("❌ Error storing sell order:", err);
  }
}

// Get Kite instance
async function instance() {
  const API_KEY = process.env.KITE_API_KEY;
  const ACCESS_TOKEN = await kv.get("kite:access_token");

  const kc = new KiteConnect({ api_key: API_KEY });
  kc.setAccessToken(ACCESS_TOKEN);

  return kc;
}

// ===========================================================
//                       MAIN HANDLER
// ===========================================================

export default async function handler(req, res) {
  // Load from KV first
  try {
    const cached = await kv.get(TRADEBOOK_KEY);
    if (cached) {
      let parsed = cached;
      try { parsed = JSON.parse(cached); } catch (e) {}
      return res.status(200).json({ ok: true, source: "kv", trades: parsed });
    }
  } catch (err) {
    console.log("⚠️ Could not load tradebook from KV:", err);
  }

  // Otherwise fetch from Kite
  try {
    const kc = await instance();
    const trades = await kc.getTrades();

    if (Array.isArray(trades) && trades.length) {
      const norm = trades.map(normalizeTrade);
      const grouped = groupTradesByOrderId(norm);

      // 🔥 Save tradebook to KV
      try {
        await kv.set(TRADEBOOK_KEY, JSON.stringify(norm));
        console.log("📦 Saved tradebook to KV:", norm.length, "trades");
      } catch (err) {
        console.log("❌ Error saving tradebook to KV:", err.message);
      }

      // Save SELL trades
      for (const t of trades) {
        if (t.transaction_type === "SELL") {
          await storeSellOrder(t);
        }
      }

      return res.status(200).json({ ok: true, source: "kite", trades: grouped });
    }
  } catch (err) {
    console.log("❌ Error fetching trades:", err);
  }

  return res.status(500).json({ ok: false, error: "Unable to fetch trades" });
}
