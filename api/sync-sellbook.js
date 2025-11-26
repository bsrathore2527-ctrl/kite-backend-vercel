
// api/sync-sellbook.js
import { kv } from "./_lib/kv.js";

const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sell_orders";

// ---- UNIVERSAL TIMESTAMP NORMALIZER ----
function getTimestampMs(t) {
  // 1) enforce-trades normalized field
  if (t._ts && Number(t._ts)) return Number(t._ts);

  // 2) tradebook.ts (already ms or sec)
  if (t.ts) {
    const n = Number(t.ts);
    return String(n).length === 10 ? n * 1000 : n;
  }

  // 3) iso fields
  if (t.iso_date) {
    const parsed = Date.parse(t.iso_date);
    if (!isNaN(parsed)) return parsed;
  }
  if (t._iso) {
    const parsed = Date.parse(t._iso);
    if (!isNaN(parsed)) return parsed;
  }

  // 4) raw fallback
  const parsed = Date.parse(t.timestamp || t.date || t.time);
  if (!isNaN(parsed)) return parsed;

  return Date.now(); // last fallback, never crash job
}

export default async function handler(req, res) {
  try {
    const tradebook = await kv.get(TRADEBOOK_KEY);
    const trades = Array.isArray(tradebook) ? tradebook : [];

    // get MTM
    const mtmObj = await kv.get("live:mtm");
    const currentMTM = Number(mtmObj?.total ?? 0);

    const todayIST = new Date().toLocaleDateString("en-IN", {
      timeZone: "Asia/Kolkata"
    });

    const sellArr = [];

    for (const t of trades) {
      const side = (t.side || "").toUpperCase();
      if (side !== "SELL") continue;

      const time_ms = getTimestampMs(t);

      const tradeDateIST = new Date(time_ms).toLocaleDateString("en-IN", {
        timeZone: "Asia/Kolkata"
      });

      // keep only today's trades
      if (tradeDateIST !== todayIST) continue;

      const last = sellArr.length > 0 ? sellArr[sellArr.length - 1] : null;
      const lastMtm = last ? Number(last.mtm) : 0;

      sellArr.push({
        instrument: t.tradingsymbol,
        qty: t.qty,
        price: t.price,
        mtm: currentMTM,
        mtm_change: currentMTM - lastMtm,
        trade_id: t.trade_id,
        time_ms,
        iso: new Date(time_ms).toLocaleString("en-IN", { timeZone: "Asia/Kolkata" })
      });
    }

    // latest first
    sellArr.sort((a, b) => b.time_ms - a.time_ms);

    // save
    await kv.set(SELLBOOK_KEY, sellArr);

    return res.status(200).json({ ok: true, count: sellArr.length });

  } catch (err) {
    console.error("sync-sellbook error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
