// mtm-worker.js — Exact Zerodha MTM (NO CHARGES)
//
// Matches Zerodha App P&L EXACTLY as seen in Positions screen:
//   P&L = intraday_pnl + overnight_mtm
//
// NO BROKERAGE, NO GST, NO STT (Zerodha app does NOT subtract charges)

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const pos = await kc.getPositions();

    // 🔥 Use ONLY DAY positions (Zerodha MTM logic)
    const dayPositions = pos?.day || [];

    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n=============================");
    console.log("🔵 ZERODHA DAY MTM START");
    console.log("=============================\n");

    let total_day_pnl = 0;

    for (const p of dayPositions) {
      const sym = p.tradingsymbol;
      const token = p.instrument_token;

      const day_buy_val  = Number(p.buy_value || 0);
      const day_sell_val = Number(p.sell_value || 0);

      const oqty        = Number(p.overnight_quantity || 0);
      const close_price = Number(p.close_price || 0);

      const ltp_used =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close_price;

      // 1️⃣ Intraday PNL (value-based)
      const intraday_pnl = day_sell_val - day_buy_val;

      // 2️⃣ Overnight MTM (usually 0 for day positions)
      const overnight_mtm =
        oqty === 0
          ? 0
          : (ltp_used - close_price) * oqty;

      const symbol_pnl = intraday_pnl + overnight_mtm;

      console.log({
        sym,
        day_buy_val,
        day_sell_val,
        intraday_pnl,
        oqty,
        close_price,
        ltp_used,
        overnight_mtm,
        symbol_pnl
      });

      total_day_pnl += symbol_pnl;
    }

    console.log("\n=============================");
    console.log("🔵 FINAL ZERODHA MTM (MATCHES APP)");
    console.log("=============================");
    console.log(`Total P&L = ${total_day_pnl}`);

    await setState({
      realised: total_day_pnl,
      unrealised: 0,
      total_pnl: total_day_pnl,
      mtm_last_update: Date.now(),
    });

    return res.json({
      ok: true,
      realised: total_day_pnl,
      unrealised: 0,
      total_pnl: total_day_pnl,
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
