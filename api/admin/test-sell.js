// /api/admin/test-sell.js
import { kv } from "../_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";
const STATE_KEY = "guardian:state";

function parseKV(raw, fallback) {
  try {
    if (!raw) return fallback;
    if (typeof raw === "string") return JSON.parse(raw);
    if (typeof raw === "object") {
      if (raw.result && typeof raw.result === "string")
        return JSON.parse(raw.result);
      return fallback;
    }
    return fallback;
  } catch {
    return fallback;
  }
}

export default async function handler(req, res) {
  try {
    const mtm = Number(req.query.mtm);
    if (Number.isNaN(mtm)) {
      return res.status(400).json({ ok: false, error: "Provide ?mtm=<number>" });
    }

    // 1. Load sellbook correctly
    const raw = await kv.get(SELLBOOK_KEY);
    let sellOrders = parseKV(raw, []);

    // 2. Calculate mtm change
    let lastMtm = sellOrders.length > 0 ? Number(sellOrders[sellOrders.length - 1].mtm) : null;
    let mtmChange = lastMtm !== null ? mtm - lastMtm : 0;

    // 3. Create entry
    const entry = {
      instrument: "TEST",
      qty: 1,
      mtm,
      mtm_change: mtmChange,
      time_ms: Date.now()
    };

    sellOrders.push(entry);

    // 4. Save sellbook
    await kv.set(SELLBOOK_KEY, JSON.stringify(sellOrders));

    // 5. Load state
    const rawState = await kv.get(STATE_KEY);
    let state = parseKV(rawState, {});

    // 6. Update consecutive losses
    let consec = Number(state.consecutive_losses ?? 0);
    consec = mtmChange < 0 ? consec + 1 : 0;
    state.consecutive_losses = consec;
    state.last_test_sell_at = Date.now();

    // 7. Save state
    await kv.set(STATE_KEY, JSON.stringify(state));

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
