// api/enforce.js
import { instance } from "./_lib/kite.js";
import { getState, setState } from "./_lib/state.js";

export default async function handler(req, res) {
  try {
    const kc = instance();
    const state = (await getState()) || {};
    const now = Date.now();

    let canceled = 0;
    let squared = 0;

    // --- 1️⃣  Pull latest orders ---------------------
    const orders = await kc.getOrders();
    const openOrders = orders.filter(o =>
      ["OPEN", "TRIGGER PENDING"].includes((o.status || "").toUpperCase())
    );

    // --- 2️⃣  Pull latest positions ------------------
    const posData = await kc.getPositions();
    const positions = posData?.net || posData || [];

    // --- 3️⃣  Enforcement if kill / block active -----
    if (state.block_new_orders || state.tripped_day) {
      // cancel open orders
      for (const o of openOrders) {
        try {
          await kc.cancelOrder(o.variety || "regular", o.order_id);
          canceled++;
        } catch (_) {}
      }

      // square off any live position
      for (const p of positions) {
        const netQty = Number(p.net_quantity || 0);
        if (netQty !== 0) {
          const side = netQty > 0 ? "SELL" : "BUY";
          try {
            await kc.placeOrder({
              exchange: p.exchange || "NSE",
              tradingsymbol: p.trading_symbol || p.tradingsymbol,
              transaction_type: side,
              quantity: Math.abs(netQty),
              order_type: "MARKET",
              product: p.product || "MIS",
              variety: "regular",
            });
            squared++;
          } catch (e) {
            console.error("Square-off failed:", e.message);
          }
        }
      }
    }

    // --- 4️⃣  Consecutive-loss & cooldown logic ------
    const realised = Number(state.realised || 0);
    if (realised < 0 && !state.cooldown_until) {
      // start 15 min cooldown
      const COOLDOWN_MIN = 15;
      state.cooldown_until = now + COOLDOWN_MIN * 60 * 1000;
      state.block_new_orders = true;
    }
    if (realised >= 0 && state.cooldown_until && now > state.cooldown_until) {
      // cooldown expired
      state.cooldown_until = 0;
      state.block_new_orders = false;
    }

    state.last_enforce_time = now;
    await setState(state);

    return res.json({
      ok: true,
      canceled,
      squared,
      cooldown_until: state.cooldown_until || 0,
      block_new_orders: !!state.block_new_orders,
    });
  } catch (err) {
    console.error(err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
