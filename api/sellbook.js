// api/sellbook.js
// Returns today's sellbook (sell events) in a shape compatible with the admin trade table.

import { getSellOrders, computeTodayConsecutive } from "./_lib/sellbook.js";
import { isAdminRequest } from "./_lib/admin-utils.js"; // optional: if you have admin auth helper

export default async function handler(req, res) {
  try {
    // Optional: protect the endpoint for admin only
    // if (!isAdminRequest(req)) return res.status(403).json({ ok: false, error: "forbidden" });

    const list = await getSellOrders(); // already returns array of { sr, tradeTs, instrument, qty, mtm }
    // Normalize to same keys tradebook uses (so front-end rendering stays identical)
    // We'll map to { instrument, transaction_type, quantity, price, trade_time, extra fields... }
    const normalized = (list || []).map((e) => ({
      instrument: e.instrument || e.symbol || e.tradingsymbol || "unknown",
      transaction_type: "SELL",
      quantity: Number(e.qty || e.quantity || 0),
      price: typeof e.price !== "undefined" ? Number(e.price) : undefined,
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
