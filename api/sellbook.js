// api/sellbook.js
// Returns stored sell-order entries saved during live tradebook fetch.

import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const key = "guardian:sell_orders";
    const raw = await kv.get(key);

    // ⭐ FIX: Upstash KV returns a native array, NOT a JSON string
    const sellOrders = Array.isArray(raw) ? raw : [];

    // Latest first
    const sorted = [...sellOrders].sort((a, b) => b.time_ms - a.time_ms);

    return res.status(200).json({
      ok: true,
      count: sorted.length,
      sell_orders: sorted,
    });

  } catch (err) {
    console.error("sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
