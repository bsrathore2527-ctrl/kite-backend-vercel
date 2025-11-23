// /api/admin/test-sell.js
// Testing endpoint to simulate SELL entries and consecutive loss logic.

import { kv } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";
const STATE_KEY = "guardian:state";

export default async function handler(req, res) {
  try {
    const mtm = Number(req.query.mtm);

    if (Number.isNaN(mtm)) {
      return res.status(400).json({
        ok: false,
        error: "Provide ?mtm=<number>"
      });
    }

    // 1️⃣ Load existing sellbook
    const raw = await kv.get(SELLBOOK_KEY);
    let sellOrders = [];
    try { sellOrders = JSON.parse(raw || "[]"); } catch { sellOrders = []; }

    // 2️⃣ Determine MTM change from last sell
    let lastMtm = null;
    if (sellOrders.length > 0) {
      lastMtm = Number(sellOrders[sellOrders.length - 1].mtm);
    }

    let mtmChange = 0;
    if (lastMtm !== null) mtmChange = mtm - lastMtm;

    // 3️⃣ Create the new simulated sell entry
    const entry = {
      instrument: "TEST",
      qty: 1,
      mtm,
      mtm_change: mtmChange,
      time_ms: Date.now()
    };

    sellOrders.push(entry);

    // 4️⃣ Save updated sellbook
    await kv.set(SELLBOOK_KEY, JSON.stringify(sellOrders));

    // 5️⃣ Load state
    const rawState = await kv.get(STATE_KEY);
    let state = {};
    try { state = JSON.parse(rawState || "{}"); } catch { state = {}; }

    // 6️⃣ Update consecutive losses based on MTM change
    let newConsec = Number(state.consecutive_losses ?? 0);

    if (mtmChange < 0) {
      newConsec += 1;     // loss → increment
    } else {
      newConsec = 0;      // profit/break even → reset
    }

    state.consecutive_losses = newConsec;
    state.last_test_sell_at = Date.now();

    // 7️⃣ Save updated state
    await kv.set(STATE_KEY, JSON.stringify(state));

    return res.status(200).json({
      ok: true,
      simulated_sell: entry,
      consecutive_losses: newConsec,
      total_sell_orders: sellOrders.length
    });

  } catch (err) {
    console.error("test-sell error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
