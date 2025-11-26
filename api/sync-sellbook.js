// api/sync-sellbook.js
import { kv } from "./_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

// Extract timestamp
function getTimestampMs(t) {
  // priority: direct numeric ts
  if (t.ts) {
    const n = Number(t.ts);
    return String(n).length === 10 ? n * 1000 : n;
  }
  // fallback to ISO/strings
  const parsed = Date.parse(t.iso_date || t._iso || t.timestamp || t.time || "");
  return isNaN(parsed) ? Date.now() : parsed;
}

export default async function handler(req, res) {
  try {
    // Load previous sellbook (append mode)
    const prevSell = (await kv.get(SELLBOOK_KEY)) || [];
    const sellArr = Array.isArray(prevSell) ? [...prevSell] : [];

    // Load today's tradebook
    const tradebook = await kv.get(TRADEBOOK_KEY);
    const trades = Array.isArray(tradebook) ? tradebook : [];

    // Get live MTM once per trade
    let mtmObj = await kv.get("live:mtm");
    const liveMTM = Number(mtmObj?.total ?? mtmObj?.mtm ?? 0);

    // Today IST
    const todayIST = new Date().toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata"
    });

    for (const t of trades) {
      if ((t.side || "").toUpperCase() !== "SELL") continue;

      const time_ms = getTimestampMs(t);
      const tradeDateIST = new Date(time_ms).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata"
      });

      if (tradeDateIST !== todayIST) continue;

      // CHECK IF THIS TRADE IS ALREADY RECORDED
      const exists = sellArr.find((x) => x.trade_id === t.trade_id);
      if (exists) continue;

      // Find previous MTM in sellbook (for change)
      const last = sellArr.length > 0 ? sellArr[sellArr.length - 1] : null;
      const lastMtm = last ? Number(last.mtm) : 0;

      // Append entry with FROZEN MTM
      sellArr.push({
        instrument: t.tradingsymbol,
        qty: t.qty,
        price: t.price,
        mtm: liveMTM,                    // FROZEN here
        mtm_change: liveMTM - lastMtm,
        trade_id: t.trade_id,
        time_ms,                         // RAW UTC
        iso: new Date(time_ms).toISOString() // NO IST conversion here
      });
    }

    // Sort latest first
    sellArr.sort((a, b) => b.time_ms - a.time_ms);

    // Persist
    await kv.set(SELLBOOK_KEY, sellArr);

    return res.status(200).json({ ok: true, count: sellArr.length });

  } catch (err) {
    console.error("sync-sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
