// api/sync-sellbook.js
// Rebuilds SELLBOOK directly from TRADEBOOK + KV MTM
// Best architecture: deterministic, consistent, no missed entries.

import { kv } from "./_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "GET only" });
  }

  try {
    // -----------------------------------------
    // 1) LOAD TRADEBOOK
    // -----------------------------------------
    const tradebook = await kv.get(TRADEBOOK_KEY);
    const trades = Array.isArray(tradebook) ? tradebook : [];

    // -----------------------------------------
    // 2) LOAD LATEST LIVE MTM FROM KV
    // -----------------------------------------
    const mtmObj = await kv.get("live:mtm");
    const currentMTM = Number(mtmObj?.total ?? 0);

    // Sellbook entries list
    const sellArr = [];

    // -----------------------------------------
    // 3) FILTER ALL SELL TRADES FROM TRADEBOOK
    // -----------------------------------------
    for (const t of trades) {
      const side = (t.side || "").toUpperCase();

      if (side !== "SELL") continue;

      // t.ts and iso_date are already normalized by enforce-trades
      const time_ms = Number(t.ts || t.time_ms || Date.now());

      // Calculate mtm_change relative to previous SELL entry
      const last = sellArr.length > 0 ? sellArr[sellArr.length - 1] : null;
      const lastMtm = last ? Number(last.mtm || 0) : 0;

      sellArr.push({
        instrument: t.tradingsymbol,
        price: Number(t.price || 0),
        qty: Number(t.qty || 0),
        side: "SELL",
        trade_id: t.trade_id,
        mtm: currentMTM,
        mtm_change: currentMTM - lastMtm,
        time_ms,
        iso: new Date(time_ms).toISOString()
      });
    }

    // -----------------------------------------
    // 4) SAVE CLEAN REBUILT SELLBOOK
    // -----------------------------------------
    await kv.set(SELLBOOK_KEY, sellArr);

    return res.status(200).json({
      ok: true,
      message: "Sellbook rebuilt successfully",
      sell_count: sellArr.length,
      sample: sellArr.slice(0, 5)
    });

  } catch (err) {
    console.error("sync-sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
