// api/sync-sellbook.js
// Rebuild SELLBOOK from TRADEBOOK (only today's trades in IST).
// Timestamps normalized to IST for correct display.

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

    // IST date of today
    const todayIST = new Date().toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata"
    });

    const sellArr = [];

    // -----------------------------------------
    // 3) FILTER SELL TRADES FOR TODAY ONLY (IST)
    // -----------------------------------------
    for (const t of trades) {
      const side = (t.side || "").toUpperCase();
      if (side !== "SELL") continue;

      const time_ms = Number(t.ts || t.time_ms || Date.now());

      // Convert timestamp → IST date for filtering
      const tradeDateIST = new Date(time_ms).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata"
      });

      if (tradeDateIST !== todayIST) continue; // Skip older trades

      // -------------------------------------
      // 4) Compute MTM change
      // -------------------------------------
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

        // Keep raw timestamp
        time_ms,

        // Display as Indian time consistently
        iso: new Date(time_ms).toLocaleString("en-IN", {
          timeZone: "Asia/Kolkata"
        })
      });
    }

    // -----------------------------------------
    // 5) Sort latest first
    // -----------------------------------------
    sellArr.sort((a, b) => Number(b.time_ms) - Number(a.time_ms));

    // -----------------------------------------
    // 6) SAVE SELLBOOK (KV)
    // -----------------------------------------
    await kv.set(SELLBOOK_KEY, sellArr);

    return res.status(200).json({
      ok: true,
      message: "Sellbook rebuilt successfully (today only, IST)",
      count: sellArr.length,
      sellbook: sellArr.slice(0, 5) // preview
    });

  } catch (err) {
    console.error("sync-sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
