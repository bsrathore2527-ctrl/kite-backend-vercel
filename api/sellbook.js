// api/sellbook.js
// Returns stored sell-order entries saved during live tradebook fetch.

import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const key = "guardian:sell_orders";
    const raw = await kv.get(key);

    let sellOrders = [];
    try { sellOrders = JSON.parse(raw || "[]"); }
    catch { sellOrders = []; }

    // Latest first
    sellOrders = [...sellOrders].reverse();

    return res.status(200).json({
      ok: true,
      count: sellOrders.length,
      sell_orders: sellOrders,
    });

  } catch (err) {
    console.error("sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
