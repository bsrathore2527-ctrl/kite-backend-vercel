import { kv } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";
const STATE_KEY = "guardian:state";

export default async function handler(req, res) {
  try {
    const mtm = Number(req.query.mtm);

    if (Number.isNaN(mtm)) {
      return res.status(400).json({ ok: false, error: "Provide ?mtm=<number>" });
    }

    // 1️⃣ Load sell orders EXACTLY as returned by Upstash
    const raw = await kv.get(SELLBOOK_KEY);
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
    await kv.set(SELLBOOK_KEY, sellOrders);

    // 5️⃣ Load state
    const rawState = await kv.get(STATE_KEY);
    let state = typeof rawState === "object" && rawState !== null ? rawState : {};

    // 6️⃣ Update consecutive losses
    let consec = Number(state.consecutive_losses ?? 0);
    consec = mtmChange < 0 ? consec + 1 : 0;

    state.consecutive_losses = consec;
    state.last_test_sell_at = Date.now();

    // 7️⃣ Save state back
    await kv.set(STATE_KEY, state);

    return res.status(200).json({
      ok: true,
      simulated_sell: entry,
      consecutive_losses: consec,
      total_sell_orders: sellOrders.length
    });

  } catch (err) {
    console.error("TEST-SELL ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
