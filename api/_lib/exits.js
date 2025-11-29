// ======================================================================
// exits.js  (MULTI-USER • FINAL • PRODUCTION)
// Combines cancelPending() and squareOffAll() into a single module.
// Perfectly matches enforce-trades.js import:
//    import { cancelPending, squareOffAll } from "./_lib/exits.js";
// ======================================================================

import { kv } from "./kv.js";
import { getKiteClient } from "../kite.js";

// --------------------------------------------------------------
// CANCEL ALL PENDING ORDERS
// --------------------------------------------------------------
export async function cancelPending(userId) {
  const kc = await getKiteClient(userId);
  if (!kc) throw new Error("Kite client unavailable");

  try {
    const allOrders = await kc.getOrders();
    if (!Array.isArray(allOrders)) return;

    for (const o of allOrders) {
      if (o.status === "OPEN" || o.status === "PENDING") {
        try {
          await kc.cancelOrder(o.order_id);
        } catch (err) {
          console.log("Cancel error:", o.order_id, err?.message || err);
        }
      }
    }
  } catch (err) {
    console.log("cancelPending() fatal:", err?.message || err);
  }
}

// --------------------------------------------------------------
// SQUARE OFF ALL OPEN POSITIONS (SAFE LOCK)
// --------------------------------------------------------------
export async function squareOffAll(userId) {
  const kc = await getKiteClient(userId);
  if (!kc) throw new Error("Kite client unavailable");

  const lockKey = `squareoff_lock:${userId}`;
  const lock = await kv.setnx(lockKey, Date.now());

  if (!lock) {
    console.log("SquareOff blocked by lock — already running");
    return;
  }

  await kv.expire(lockKey, 5);

  try {
    const posKey = `positions:${userId}`;
    const positions = (await kv.get(posKey)) || [];

    for (const p of positions) {
      const qty = Number(p.qty || 0);
      if (qty === 0) continue;

      const absQty = Math.abs(qty);
      const side = qty > 0 ? "SELL" : "BUY";

      try {
        await kc.placeOrder({
          exchange: p.exchange || "NSE",
          tradingsymbol: p.symbol || p.tradingsymbol || "",
          transaction_type: side,
          product: p.product || "MIS",
          quantity: absQty,
          order_type: "MARKET"
        });
      } catch (err) {
        console.log("Squareoff order error:", err?.message || err);
      }
    }
  } finally {
    await kv.del(lockKey);
  }
}
