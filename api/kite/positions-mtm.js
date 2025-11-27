// api/kite/positions-mtm.js
import { instance } from "../_lib/kite.js";
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    // ----------------------------------
    // 1) Fetch fresh Zerodha positions
    // ----------------------------------
    const kc = await instance();
    const pos = await kc.getPositions();

    // Zerodha sometimes returns pos.data.net or pos.net
    const net = pos?.data?.net || pos?.net || [];

    let totalUnreal = 0;
    let totalReal = 0;

    // ----------------------------------------------------
    // 2) Enrich + normalize positions required by ALL APIs
    // ----------------------------------------------------
    const enriched = net.map(p => {
      const unreal = Number(p.unrealised || p.unrealized || 0);
      const real = Number(p.realised || p.realized || 0);

      totalUnreal += unreal;
      totalReal += real;

      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      const ltp = Number(p.last_price || p.ltp || 0);
      const avg = Number(p.average_price || p.avg_price || 0);

      return {
        // Needed for square-off and risk enforcement
        exchange: p.exchange || "NSE",
        tradingsymbol: p.tradingsymbol || p.trading_symbol,
        product: p.product || "MIS",

        // Position quantity
        quantity: qty,
        net_quantity: qty,

        // Prices
        average_price: avg,
        last_price: ltp,

        // PnL
        realised: real,
        unrealised: unreal,
        pnl: real + unreal,

        // Keep full raw Zerodha object for future requirements
        raw: p
      };
    });

    const totalPnl = totalReal + totalUnreal;

    // --------------------------------------
    // 3) Master KV snapshot for whole system
    // --------------------------------------
    await kv.set("positions_live", {
      ts: Date.now(),
      net: enriched,               // full enriched positions
      total_unrealised: totalUnreal,
      total_realised: totalReal,
      total_pnl: totalPnl
    });

    // --------------------------------------------------
    // 4) Also write legacy MTM key (used by enforce-trades)
    // --------------------------------------------------
    await kv.set("live:mtm", {
      unrealised: totalUnreal,
      realised: totalReal,
      total: totalPnl,
      polled_at: Date.now(),
      source: "positions-mtm"
    });

    // -------------------------------------------
    // 5) Send simple response for debug/monitoring
    // -------------------------------------------
    return res.status(200).json({
      ok: true,
      realised: totalReal,
      unrealised: totalUnreal,
      total_pnl: totalPnl,
      saved: true
    });

  } catch (e) {
    return res
      .status(500)
      .setHeader("Cache-Control", "no-store")
      .json({ ok: false, error: String(e) });
  }
}
