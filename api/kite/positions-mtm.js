// api/kite/positions-mtm.js
import { instance } from "../_lib/kite.js";
import { kv, todayKey } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const kc = await instance();
    const pos = await kc.getPositions(); // /portfolio/positions

    const net = pos?.data?.net || pos?.net || [];

    let totalPnl = 0;
    let totalUnreal = 0;
    let totalReal = 0;

    for (const p of net) {
      // If Kite gives pnl/m2m/unrealised directly, you can use:
      const u = Number(p.unrealised || 0);
      const r = Number(p.realised || 0);
      totalUnreal += u;
      totalReal += r;
      totalPnl += u + r;
    }

    // Save to KV so /api/state can read it
    const key = `state:${todayKey()}`;
    const prev = (await kv.get(key)) || {};

    await kv.set(key, {
      ...prev,
      realised: totalReal,
      unrealised: totalUnreal,
      mtm_total: totalPnl,
      mtm_updated_at: Date.now()
    });
// ALSO write live MTM for api/state.js
await kv.set("live:mtm", {
  realised: totalReal,
  unrealised: totalUnreal,
  total: totalPnl,
  mtm: totalPnl,      // for compatibility
  updated_at: Date.now()
});

    res
      .status(200)
      .setHeader("Cache-Control", "no-store")
      .json({
        ok: true,
        realised: totalReal,
        unrealised: totalUnreal,
        total_pnl: totalPnl
      });

  } catch (e) {
    res
      .status(500)
      .setHeader("Cache-Control", "no-store")
      .json({ ok: false, error: String(e) });
  }
}
