// api/sellbook.js
// Returns stored sell-order entries saved during live tradebook fetch.

import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const key = "guardian:sell_orders";
    const raw = await kv.get(key);

    // Upstash KV returns native JS objects/arrays in this project
    const sellOrders = Array.isArray(raw) ? raw : [];

    // Latest first by time_ms if present, else keep insertion order reversed
    const sorted = [...sellOrders].sort((a, b) => {
      const ta = typeof a.time_ms === 'number' ? a.time_ms : 0;
      const tb = typeof b.time_ms === 'number' ? b.time_ms : 0;
      return tb - ta;
    });

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
