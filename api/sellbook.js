// api/sellbook.js
// Returns today's sellbook (sell events) in a shape compatible with the admin trade table.

import { getSellOrders, computeTodayConsecutive } from "./_lib/sellbook.js";

export default async function handler(req, res) {
  try {
    const list = await getSellOrders(); // returns array of { sr, tradeTs, instrument, qty, mtm }

    // Normalize to same keys tradebook uses (so frontend rendering stays identical)
    const normalized = (list || []).map((e) => ({
      instrument: e.instrument || e.symbol || e.tradingsymbol || "unknown",
      transaction_type: "SELL",
      quantity: Number(e.qty || e.quantity || 0),
      price: typeof e.price !== "undefined" ? Number(e.price) : null,
      trade_time: Number(e.tradeTs || e.trade_time || Date.now()),
      mtm: Number(e.mtm || 0),
      sr: Number(e.sr || 0),
    }));

    const cons = await computeTodayConsecutive();

    return res.status(200).json({
      ok: true,
      list: normalized,
      consecutive: cons.consecutiveCount || 0,
      history: cons.history || [],
    });
  } catch (err) {
    console.error("sellbook API error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
