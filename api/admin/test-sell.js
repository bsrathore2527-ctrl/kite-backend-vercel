// /api/admin/test-sell.js
// Testing endpoint to simulate SELL entries and consecutive loss logic.

import { kv } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";
const STATE_KEY = "guardian:state";

export default async function handler(req, res) {
  try {
    console.log("TEST-SELL: Running with key =", SELLBOOK_KEY);

    const mtm = Number(req.query.mtm);

    if (Number.isNaN(mtm)) {
      return res.status(400).json({
        ok: false,
        error: "Provide ?mtm=<number>"
      });
    }

    // 1️⃣ ---- Load existing sellbook safely ----
    const raw = await kv.get(SELLBOOK_KEY);
    let sellOrders = [];

    try {
      if (raw) {
        const str = typeof raw === "string" ? raw : raw?.result;
        sellOrders = JSON.parse(str || "[]");
      }
    } catch (e) {
      console.warn("TEST-SELL: Failed to parse sell_orders:", e);
      sellOrders = [];
    }

    if (!Array.isArray(sellOrders)) sellOrders = [];

    console.log("TEST-SELL: Loaded sellOrders count =", sellOrders.length);

    // 2️⃣ ---- Determine MTM change from last sell ----
    let lastMtm = null;
    if (sellOrders.length > 0) {
      lastMtm = Number(sellOrders[sellOrders.length - 1].mtm);
    }

    let mtmChange = 0;
    if (lastMtm !== null) {
      mtmChange = mtm - lastMtm;
    }

    // 3️⃣ ---- Create new simulated sell entry ----
    const entry = {
      instrument: "TEST",
      qty: 1,
      mtm,
      mtm_change: mtmChange,
      time_ms: Date.now()
    };

    sellOrders.push(entry);

    // 4️⃣ ---- Save updated sellbook ----
    try {
      await kv.set(SELLBOOK_KEY, JSON.stringify(sellOrders));
    } catch (err) {
      console.error("TEST-SELL: Failed to save sellOrders:", err);
    }

    // 5️⃣ ---- Load state safely ----
    const rawState = await kv.get(STATE_KEY);
    let state = {};

    try {
      if (rawState) {
        const st = typeof rawState === "string" ? rawState : rawState?.result;
        state = JSON.parse(st || "{}");
      }
    } catch (e) {
      console.warn("TEST-SELL: Failed to parse guardian:state:", e);
      state = {};
    }

    // 6️⃣ ---- Update consecutive losses ----
    let newConsec = Number(state.consecutive_losses ?? 0);

    if (mtmChange < 0) {
      newConsec += 1;   // loss → increment
    } else {
      newConsec = 0;    // profit/break-even → reset
    }

    state.consecutive_losses = newConsec;
    state.last_test_sell_at = Date.now();

    // 7️⃣ ---- Save updated state ----
    try {
      await kv.set(STATE_KEY, JSON.stringify(state));
    } catch (err) {
      console.error("TEST-SELL: Failed to save state:", err);
    }

    // 8️⃣ ---- Return result ----
    return res.status(200).json({
      ok: true,
      simulated_sell: entry,
      consecutive_losses: newConsec,
      total_sell_orders: sellOrders.length
    });

  } catch (err) {
    console.error("TEST-SELL: Unexpected error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
