// api/_lib/kill.js
// Shared kill logic (refactored from hub.js).
// Drop this file into api/_lib/kill.js in your repo.

import { instance as kiteInstance } from "./kite.js";
import { kv, todayKey } from "./kv.js";

/**
 * cancelPending - cancel open / trigger orders using Kite client
 * @param kc - kite client instance with getOrders() and cancelOrder(variety, order_id)
 */
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = String(o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s.includes("TRIGGER PENDING") || s.includes("TRIGGERED");
    });
    let cancelled = 0;
    for (const o of pending) {
      try {
        const variety = o.variety || "regular";
        const id = o.order_id || o.orderId || o.id;
        if (!id) continue;
        await kc.cancelOrder(variety, id);
        cancelled++;
      } catch (e) {
        // ignore per-order failures
      }
    }
    return cancelled;
  } catch (e) {
    return 0;
  }
}

/**
 * squareOffAll - read net positions and place market orders to neutralize
 * Uses kc.getPositions().net format (as in hub.js)
 */
async function squareOffAll(kc) {
  try {
    const positions = await kc.getPositions();
    const net = positions?.net || [];
    let squared = 0;
    for (const p of net) {
      try {
        const qty = Number(p.net_quantity ?? p.quantity ?? 0);
        if (!qty) continue;
        const side = qty > 0 ? "SELL" : "BUY";
        const absQty = Math.abs(qty);
        const tradingsymbol = p.tradingsymbol || p.trading_symbol || p.instrumentToken || p.symbol;
        const exchange = p.exchange || p.exchange_code || "NSE";
        await kc.placeOrder("regular", {
          exchange,
          tradingsymbol,
          transaction_type: side,
          quantity: absQty,
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch (e) {
        // ignore per-position failure
      }
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

/**
 * killNow / enforceShutdown - the exported shared function.
 * Accepts an optional kite client instance `kc`. If not provided, it will create one.
 * meta is an object stored into the enforcement_meta in KV for auditing.
 */
export async function killNow({ kc = null, meta = {} } = {}) {
  let createdLocal = false;
  try {
    if (!kc) {
      // kiteInstance imported from repo helpers (hub.js used safeInstance wrapping instance())
      kc = await kiteInstance();
      createdLocal = true;
    }
  } catch (e) {
    // cannot create kite client; proceed to still set tripped state if possible
  }

  const cancelled = kc ? await cancelPending(kc) : 0;
  const squared = kc ? await squareOffAll(kc) : 0;

  // persist KV state under risk:<todayKey>
  try {
    const key = `risk:${todayKey()}`;
    const cur = (await kv.get(key)) || {};
    const next = { ...cur, tripped_day: true, last_enforced_at: Date.now(), enforcement_meta: meta };
    await kv.set(key, next);
    return { cancelled, squared, state: next };
  } catch (e) {
    return { cancelled, squared, state: null, error: String(e) };
  } finally {
    // close kite client if created locally
    try {
      if (createdLocal && kc && typeof kc.close === "function") await kc.close();
    } catch (_) {}
  }
}

export default killNow;
