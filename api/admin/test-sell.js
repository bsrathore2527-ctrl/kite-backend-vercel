// /api/admin/test-sell.js
// Testing endpoint to simulate SELL entries and consecutive loss logic,
// wired into the same risk state used by /api/state and enforce-trades.

import { kv, getState, setState } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";

export default async function handler(req, res) {
  try {
    const mtm = Number(req.query.mtm);

    if (Number.isNaN(mtm)) {
      return res.status(400).json({ ok: false, error: "Provide ?mtm=<number>" });
    }

    // 1️⃣ Load sell orders from KV (native array in this project)
    const raw = kv ? await kv.get(SELLBOOK_KEY) : null;
    let sellOrders = Array.isArray(raw) ? raw : [];

    // 2️⃣ Compute MTM change
    let lastMtm = sellOrders.length > 0 ? Number(sellOrders[sellOrders.length - 1].mtm) : null;
    if (!Number.isFinite(lastMtm)) lastMtm = null;
    const mtmChange = lastMtm !== null ? mtm - lastMtm : 0;

    // 3️⃣ Create entry
    const time_ms = Date.now();
    const entry = {
      instrument: "TEST",
      qty: 1,
      mtm,
      mtm_change: mtmChange,
      time_ms
    };

    sellOrders.push(entry);

    // 4️⃣ Save updated sellbook
    if (kv) {
      await kv.set(SELLBOOK_KEY, sellOrders);
    }

    // 5️⃣ Use SAME state mechanism as /api/state & enforce-trades
    const state = await getState();
    let consec = Number(state.consecutive_losses ?? 0);
    if (!Number.isFinite(consec)) consec = 0;

    // Increment or reset consecutive losses
    consec = mtmChange < 0 ? consec + 1 : 0;

    const maxConsec = Number(state.max_consecutive_losses ?? 0);

    // 6️⃣ Build patch for setState
    const patch = {
      consecutive_losses: consec,
      last_test_sell_at: time_ms
    };

    // If limit reached → trip the day (block new orders)
    if (maxConsec > 0 && consec >= maxConsec) {
      patch.tripped_day = true;
      patch.block_new_orders = true;
      patch.trip_reason = "max_consecutive_losses";
    }

    const nextState = await setState(patch);

    return res.status(200).json({
      ok: true,
      simulated_sell: entry,
      consecutive_losses: consec,
      total_sell_orders: sellOrders.length,
      tripped_day: nextState.tripped_day === true,
      trip_reason: nextState.trip_reason ?? null
    });

  } catch (err) {
    console.error("TEST-SELL ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
