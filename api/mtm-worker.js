// mtm-worker.js
// Clean MTM worker — calculates P&L using:
// 1) Zerodha positions.realised  (official FIFO realised)
// 2) ltp:all KV key for live LTPs (for unrealised)
// No baselines, no FIFO, no tradebook required.

import { kv } from "./_lib/kv.js";
import { getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

async function handler(req, res) {
  if (req.method === "OPTIONS") {
    return res.status(204).end();
  }

  try {
    const kc = await instance();

    // Fetch positions from Zerodha
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    // Fetch all LTPs stored by ticker-worker
    const ltpAll = (await kv.get("ltp:all")) || {};

    let realised = 0;
    let unrealised = 0;

    for (const p of net) {
      const qty = Number(p.net_quantity);
      if (!qty) continue;

      const avg = Number(p.average_price || 0);
      const token = Number(p.instrument_token);

      // Prefer LTP from ticker
      const ltp =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||    // fallback to Zerodha last_price
        0;

      // Zerodha realised PNL (official FIFO)
      realised += Number(p.realised || p.realised_pnl || 0);

      // UNREALISED PNL from open positions
      if (qty > 0) {
        // Long
        unrealised += (ltp - avg) * qty;
      } else {
        // Short
        unrealised += (avg - ltp) * Math.abs(qty);
      }
    }

    const total = realised + unrealised;

    // Save to KV state
    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now()
    });

    console.log("🟢 MTM FINAL:", {
      realised,
      unrealised,
      total_pnl: total
    });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl: total
    });

  } catch (err) {
    console.error("MTM worker error:", err?.message || err);
    await setState({
      mtm_error: String(err),
      mtm_last_error_at: Date.now()
    });
    return res.status(500).json({ ok: false, error: String(err) });
  }
}

export default handler;
