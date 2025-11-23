// /api/admin/test-sell.js
// Testing endpoint to simulate SELL entries and consecutive loss logic.

import { kv, getState, setState } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";

export default async function handler(req, res) {
  try {
    const mtm = Number(req.query.mtm);

    if (Number.isNaN(mtm)) {
      return res.status(400).json({ ok: false, error: "Provide ?mtm=<number>" });
    }

    // 1️⃣ Load sell orders EXACTLY as returned by Upstash
    const raw = kv ? await kv.get(SELLBOOK_KEY) : null;
    let sellOrders = Array.isArray(raw) ? raw : [];

    // 2️⃣ Compute MTM change
    let lastMtm = sellOrders.length > 0 ? sellOrders[sellOrders.length - 1].mtm : null;
    let mtmChange = lastMtm !== null ? mtm - lastMtm : 0;

    // 3️⃣ Create entry
    const entry = {
      instrument: "TEST",
      qty: 1,
      mtm,
      mtm_change: mtmChange,
      time_ms: Date.now()
    };

    sellOrders.push(entry);

    // 4️⃣ Save updated array (no stringify needed)
    if (kv) {
      await kv.set(SELLBOOK_KEY, sellOrders);
    }

    // 5️⃣ Load risk state using the SAME mechanism as /api/state
    const state = await getState(); // reads from risk:YYYY-MM-DD
    let consec = Number(state.consecutive_losses ?? 0);

    // 6️⃣ Update consecutive losses
    consec = mtmChange < 0 ? consec + 1 : 0;

    // 7️⃣ Persist back via setState, so /api/state sees it
    const updatedState = await setState({
      consecutive_losses: consec,
      last_test_sell_at: Date.now()
    });

    return res.status(200).json({
      ok: true,
      simulated_sell: entry,
      consecutive_losses: consec,
      total_sell_orders: sellOrders.length,
      state_snapshot: updatedState
    });

  } catch (err) {
    console.error("TEST-SELL ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
