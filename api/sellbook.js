// api/sellbook.js
// Simple API to return clean SELLBOOK from KV
// SELLBOOK is now generated ONLY by /api/sync-sellbook.js

import { kv } from "./_lib/kv.js";

const SELLBOOK_KEY = "guardian:sell_orders";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({
      ok: false,
      error: "Method not allowed"
    });
  }

  try {
    // Read sellbook from KV
    const raw = await kv.get(SELLBOOK_KEY);
    const list = Array.isArray(raw) ? raw : [];

    // Sort by time descending (latest first)
    list.sort((a, b) => Number(b.time_ms || 0) - Number(a.time_ms || 0));

    return res
      .setHeader("Cache-Control", "no-store")
      .status(200)
      .json({
        ok: true,
        count: list.length,
        sellbook: list
      });

  } catch (err) {
    console.error("sellbook.js error:", err);
    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
