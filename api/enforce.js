// api/enforce.js
import { instance, getClientId } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js";
import { USER_KEYS } from "../lib/keys.js";

/* ------------------------------------------------------
   Helpers: send(), ok(), bad()
------------------------------------------------------ */
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

/* ------------------------------------------------------
   GLOBAL SQUAREOFF LOCK
   Prevents double/triple sells when using KV positions
------------------------------------------------------ */
async function acquireSquareoffLock() {
  const lock = await kv.get("risk:squareoff_lock");
  if (lock === "1") return false;
  await kv.set("risk:squareoff_lock", "1");
  return true;
}

async function releaseSquareoffLock() {
  await kv.del("risk:squareoff_lock");
}

/* ------------------------------------------------------
   CANCEL PENDING ORDERS (unchanged)
------------------------------------------------------ */
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER");
    });
    let cancelled = 0;
    for (const o of pending) {
      try {
        await kc.cancelOrder(o.variety || "regular", o.order_id);
        cancelled++;
      } catch (e) {
        // ignore failures
      }
    }
    return cancelled;
  } catch (e) {
    return 0;
  }
}

/* ------------------------------------------------------
   SAFE SQUAREOFF USING KV POSITIONS + LOCK
------------------------------------------------------ */
async function squareOffAll(kc) {
  // Ensure only ONE squareoff runs anywhere in backend
  const canRun = await acquireSquareoffLock();
  if (!canRun) {
    console.log("⚠️ Squareoff blocked — another squareoff is already running");
    return 0;
  }

  try {
    const userId = await getClientId();
    let raw = await kv.get(USER_KEYS.positions(userId));
    let positions = [];

    try {
      positions = JSON.parse(raw) || [];
    } catch {
      positions = [];
    }

    if (!Array.isArray(positions) || positions.length === 0) {
      console.log("No KV positions to square off");
      return 0;
    }

    let squared = 0;

    for (const p of positions) {
      const qty = Number(p.quantity ?? p.net_quantity ?? 0);
      if (!qty) continue;

      const side = qty > 0 ? "SELL" : "BUY";
      const absQty = Math.abs(qty);

      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol,
          transaction_type: side,
          quantity: absQty,
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch (e) {
        // ignore per-symbol failure
      }
    }

    return squared;
  } catch (e) {
    return 0;
  } finally {
    await releaseSquareoffLock(); // always unlock
  }
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */
export default async function handler(req, res) {
  try {
    if (req.method !== "GET" && req.method !== "POST") 
      return bad(res, "Method not allowed");

    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};

    // If no trip, do nothing
    if (!state.tripped_day && !state.block_new_orders) {
      return ok(res, { 
        tick: new Date().toISOString(), 
        enforced: false, 
        reason: "not_tripped" 
      });
    }

    // Need Kite instance
    let kc;
    try {
      kc = await instance();
    } catch (e) {
      return ok(res, { 
        enforced: false, 
        note: "Kite not connected", 
        error: e.message 
      });
    }

    // Enforce actions
    const cancelled = await cancelPending(kc);
    const squared = await squareOffAll(kc);

    const next = { ...state, last_enforced_at: Date.now() };
    await kv.set(key, next);

    return ok(res, {
      tick: new Date().toLocaleTimeString("en-IN", { 
        timeZone: "Asia/Kolkata", 
        hour12: false 
      }),
      enforced: true,
      cancelled,
      squared
    });

  } catch (err) {
    return send(res, 500, { 
      ok: false, 
      error: err.message || String(err) 
    });
  }
}
