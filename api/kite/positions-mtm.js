// api/kite/positions-mtm.js
import { instance } from "../_lib/kite.js";
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();   // /portfolio/positions

    // Zerodha may return pos.net OR pos.data.net
    const net = pos?.data?.net || pos?.net || [];

    // --------------------------------------------
    // SAME LOGIC AS positions.js  (✔ EXACT MATCH)
    // --------------------------------------------
    let totalUnreal = 0;
    let totalReal = 0;

    for (const p of net) {
      totalUnreal += Number(p.unrealised || 0);
      totalReal += Number(p.realised || 0);
    }

    const totalPnl = totalUnreal + totalReal;

    // --------------------------------------------
    // SAVE EXACTLY LIKE positions.js
    // --------------------------------------------
    await kv.set("live:mtm", {
      realised: totalReal,
      unrealised: totalUnreal,
      total_pnl: totalPnl,
      ts: Date.now()
    });

    // --------------------------------------------
    // RESPONSE — SAME SHAPE AS positions.js
    // --------------------------------------------
    res
      .status(200)
      .setHeader("Cache-Control", "no-store")
      .json({
        ok: true,
        realised: totalReal,
        unrealised: totalUnreal,
        total_pnl: totalPnl,
        live_mtm_written: true
      });

  } catch (e) {
    res
      .status(500)
      .setHeader("Cache-Control", "no-store")
      .json({ ok: false, error: String(e) });
  }
}
