// api/enforce.js
// Cancels pending orders and squares off net positions when kill flags active.
// Minimal: uses your existing _lib/kite.js for instance() and _lib/kv.js (or Upstash fallback).

import { instance } from "./_lib/kite.js";     // should return a KiteConnect instance or throw
import { kv, todayKey } from "./_lib/kv.js";    // or your kv wrapper

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pend = (orders || []).filter(o => {
      const st = (o.status || "").toUpperCase();
      return st === "OPEN" || st.includes("TRIGGER");
    });
    let cancelled = 0;
    for (const o of pend) {
      try {
        // kc.cancelOrder(variety, order_id) or kc.cancelOrder(order_id)
        if (o.order_id && typeof kc.cancelOrder === "function") {
          await kc.cancelOrder(o.variety || "regular", o.order_id);
          cancelled++;
        }
      } catch (e) { /* ignore per-order failure */ }
    }
    return cancelled;
  } catch (e) {
    return 0;
  }
}

async function squareOffAll(kc) {
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let squared = 0;
    for (const p of net) {
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      if (!qty) continue;
      const side = qty > 0 ? "SELL" : "BUY";
      const absQty = Math.abs(qty);
      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol || p.instrument_token,
          transaction_type: side,
          quantity: absQty,
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch (e) {
        // could log e.message
      }
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

export default async function handler(req, res) {
  try {
    // Only GET allowed (QStash will call GET). You can change to POST if you prefer.
    if (req.method !== "GET") return bad(res, "Method not allowed");

    // Read state from KV (your existing key)
    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};

    // If no enforcement required, just return
    if (!state.tripped_day && !state.block_new_orders) {
      return ok(res, { tick: new Date().toISOString(), enforced: false, reason: "not_tripped" });
    }

    // Try to get kite instance
    let kc;
    try {
      kc = await instance(); // should throw if no token
    } catch (e) {
      // can't reach kite — set flag and return non-fatal
      return ok(res, { tick: new Date().toISOString(), enforced: false, note: "kite_unavailable", error: e.message });
    }

    // Cancel pending orders
    const canceled = await cancelPending(kc);

    // Square off net positions
    const squared = await squareOffAll(kc);

    // Optionally persist that enforcement ran (timestamp)
    const next = { ...state, last_enforced_at: Date.now() };
    await kv.set(key, next);

    return ok(res, { tick: new Date().toISOString(), enforced: true, canceled, squared });
  } catch (err) {
    console.error("ENFORCE ERR", err && err.stack ? err.stack : err);
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
