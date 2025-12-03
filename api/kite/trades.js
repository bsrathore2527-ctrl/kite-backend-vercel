// ===========================================================
//                TRADES ENDPOINT (FULLY FIXED)
// ===========================================================

import kv from "../_lib/kv.js";
import KiteConnect from "kiteconnect";

const TRADEBOOK_KEY = "guardian:tradebook";

// NORMALIZE ZERODHA TRADE FORMAT → MTM-READY FORMAT
function normalizeTrade(t) {
  const ts = new Date(t.exchange_timestamp || t.fill_timestamp).getTime();
  return {
    ts,
    iso_date: t.exchange_timestamp || t.fill_timestamp || null,
    tradingsymbol: t.tradingsymbol,
    account_id: t.account_id || null,
    trade_id: t.trade_id,
    side: t.transaction_type,       // ✔ "BUY" / "SELL"
    qty: t.quantity,                // ✔ qty
    price: t.average_price || 0,    // ✔ entry/exit price
    raw: t,                         // ✔ original trade stored
    _ts: ts,
    _iso: t.exchange_timestamp || t.fill_timestamp || null,
  };
}

// GROUP TRADES BY ORDER (your old logic preserved)
function groupTradesByOrderId(normTrades) {
  const map = new Map();
  for (const t of normTrades) {
    const oid = t.raw.order_id || "unknown";
    if (!map.has(oid)) map.set(oid, []);
    map.get(oid).push(t);
  }
  return Object.fromEntries(map.entries());
}

// STORE SELL EVENTS (unchanged)
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

// KITE INSTANCE (unchanged)
async function instance() {
  const API_KEY = process.env.KITE_API_KEY;
  const ACCESS_TOKEN = await kv.get("kite:access_token");

  const kc = new KiteConnect({ api_key: API_KEY });
  kc.setAccessToken(ACCESS_TOKEN);

  return kc;
}

// ===========================================================
//                     MAIN HANDLER
// ===========================================================

export default async function handler(req, res) {

  // 1️⃣ TRY LOADING FROM KV FIRST
  try {
    const cached = await kv.get(TRADEBOOK_KEY);
    if (cached) {
      let parsed = cached;
      try { parsed = JSON.parse(cached); } catch {}
      return res.status(200).json({
        ok: true,
        source: "kv",
        trades: parsed,
      });
    }
  } catch (err) {
    console.log("⚠️ Could not load tradebook from KV:", err);
  }

  // 2️⃣ FETCH FROM KITE IF KV EMPTY
  try {
    const kc = await instance();
    const trades = await kc.getTrades() || [];

    if (trades.length) {

      // -------------------------------------------------------
      // 🔥 CRITICAL FIX: NORMALIZE BEFORE SAVING TO KV
      // -------------------------------------------------------
      const norm = trades.map(normalizeTrade);

      try {
        await kv.set(TRADEBOOK_KEY, JSON.stringify(norm));
        console.log("📦 [trades] Saved NORMALIZED tradebook to KV:", norm.length);
      } catch (err) {
        console.log("❌ Error saving tradebook to KV:", err?.message || err);
      }

      // Group for UI (unchanged)
      const grouped = groupTradesByOrderId(norm);

      // Process SELL trades
      for (const t of trades) {
        if (t.transaction_type === "SELL") {
          await storeSellOrder(t);
        }
      }

      return res.status(200).json({
        ok: true,
        source: "kite",
        trades: grouped,
      });
    }

  } catch (err) {
    console.log("❌ Error fetching trades:", err);
  }

  return res.status(500).json({
    ok: false,
    error: "Unable to fetch trades from KV or Kite",
  });
}
