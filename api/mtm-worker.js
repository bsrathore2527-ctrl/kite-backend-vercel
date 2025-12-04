// mtm-worker.js — Exact Zerodha MTM Calculation
// ---------------------------------------------------------------
// This matches Zerodha's P&L exactly:
// per symbol:
//
//   intraday_pnl   = (day_sell_value - day_buy_value)
//   overnight_mtm  = (ltp - close_price) * overnight_quantity
//
//   symbol_pnl = intraday_pnl + overnight_mtm
//
// total_day_pnl = sum(symbol_pnl)

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n=============================");
    console.log("🔵 ZERODHA-MTM (EXACT MATCH) START");
    console.log("=============================\n");

    console.log("DEBUG POSITIONS:");
    console.log(JSON.stringify(net, null, 2));

    console.log("\nDEBUG LTPALL:");
    console.log(JSON.stringify(ltpAll, null, 2));

    let total_day_pnl = 0;

    for (const p of net) {
      const sym = p.tradingsymbol;
      const token = p.instrument_token;

      const day_buy_val  = Number(p.day_buy_value  || 0);
      const day_sell_val = Number(p.day_sell_value || 0);

      const oqty        = Number(p.overnight_quantity || 0);
      const close_price = Number(p.close_price || 0);

      const ltp_used =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close_price;

      // Intraday P&L (Zerodha uses value method)
      const intraday_pnl = day_sell_val - day_buy_val;

      // Overnight MTM
      const overnight_mtm =
        oqty === 0
          ? 0
          : (ltp_used - close_price) * oqty;

      const symbol_pnl = intraday_pnl + overnight_mtm;

      console.log("\n----------------------------");
      console.log(`🔸 SYMBOL: ${sym}`);
      console.log("----------------------------");
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
    console.log("🔵 FINAL ZERODHA MTM");
    console.log("=============================");
    console.log(`Total Day MTM = ${total_day_pnl}`);

    await setState({
      realised: total_day_pnl,
      unrealised: 0,
      total_pnl: total_day_pnl,
      mtm_last_update: Date.now(),
    });

    console.log("\nSTATE WRITTEN:", {
      realised: total_day_pnl,
      unrealised: 0,
      total_pnl: total_day_pnl,
    });

    console.log("\n🔵 ZERODHA-MTM END\n");

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
