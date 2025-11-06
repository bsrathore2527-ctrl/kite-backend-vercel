// api/enforce.js
import { instance } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js";

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

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
        // ignore individual cancel errors
      }
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
  }
}

async function handler(req, res) {
  try {
    // accept GET or POST from UI / scheduler
    if (req.method !== "GET" && req.method !== "POST")
      return bad(res, "Method not allowed");

    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};

    if (!state.tripped_day && !state.block_new_orders) {
      return ok(res, {
        tick: new Date().toISOString(),
        enforced: false,
        reason: "not_tripped"
      });
    }

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
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}

// ✅ Added for Option B internal calls:
export { cancelPending, squareOffAll };
export default handler;
