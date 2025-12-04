// mtm-worker.js (Zerodha Day P&L Version - FULL DEBUG)
// -----------------------------------------------------
// EXACT Zerodha Day P&L:
// DAY_PNL = (day_sell_value – day_buy_value) + (ltp – close_price) × overnight_qty
//
// Writes to KV:
// realised   = day_pnl_total
// unrealised = 0
// total_pnl  = day_pnl_total
//
// With full DEBUG logging

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n\n=============================");
    console.log("🔵 ZERODHA-MTM WORKER STARTED");
    console.log("=============================\n");

    console.log("DEBUG POSITIONS (net):");
    console.log(JSON.stringify(net, null, 2));

    console.log("\nDEBUG LTP ALL:");
    console.log(JSON.stringify(ltpAll, null, 2));

    let day_pnl_total = 0;

    // -----------------------------------------------------------
    // PROCESS EACH SYMBOL
    // -----------------------------------------------------------
    for (const p of net) {
      const sym   = p.tradingsymbol;
      const token = p.instrument_token;

      const oqty  = Number(p.overnight_quantity || 0);

      const day_buy_val  = Number(p.day_buy_value  || 0);
      const day_buy_qty  = Number(p.day_buy_quantity || 0);

      const day_sell_val = Number(p.day_sell_value || 0);
      const day_sell_qty = Number(p.day_sell_quantity || 0);

      const close = Number(p.close_price || 0);
      const last  =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close;

      console.log("\n----------------------------");
      console.log(`🔸 SYMBOL: ${sym}`);
      console.log("----------------------------");

      console.log("Raw Data:");
      console.log({
        sym,
        oqty,
        close_price: close,
        ltp_used: last,
        day_buy_qty,
        day_buy_val,
        day_sell_qty,
        day_sell_val
      });

      // ------------------------------------
      // 1) Intraday Value P&L
      // ------------------------------------
      const intraday_pnl = day_sell_val - day_buy_val;

      console.log(`➡️ Intraday PNL (value-based) = day_sell_val - day_buy_val`);
      console.log(`   = ${day_sell_val} - ${day_buy_val}`);
      console.log(`   = ${intraday_pnl}`);

      // ------------------------------------
      // 2) Overnight Mark-to-Market
      // ------------------------------------
      const overnight_mtm = (last - close) * oqty;

      console.log(`➡️ Overnight MTM = (LTP - close_price) × overnight_qty`);
      console.log(`   = (${last} - ${close}) × ${oqty}`);
      console.log(`   = ${overnight_mtm}`);

      // ------------------------------------
      // 3) Symbol P&L
      // ------------------------------------
      const symbol_pnl = intraday_pnl + overnight_mtm;

      console.log(`➡️ SYMBOL TOTAL PNL = intraday_pnl + overnight_mtm`);
      console.log(`   = ${intraday_pnl} + ${overnight_mtm}`);
      console.log(`   = ${symbol_pnl}`);

      day_pnl_total += symbol_pnl;
    }

    // -----------------------------------------------------------
    // Write KV values (Zerodha P&L only)
    // -----------------------------------------------------------
    console.log("\n=============================");
    console.log("🔵 FINAL ZERODHA DAY P&L");
    console.log("=============================");
    console.log(`Total Day PNL = ${day_pnl_total}`);

    await setState({
      realised: day_pnl_total,
      unrealised: 0,
      total_pnl: day_pnl_total,
      mtm_last_update: Date.now(),
    });

    console.log("STATE WRITTEN TO KV:", {
      realised: day_pnl_total,
      unrealised: 0,
      total_pnl: day_pnl_total,
    });

    console.log("\n🔵 ZERODHA-MTM WORKER END\n\n");

    return res.json({
      ok: true,
      realised: day_pnl_total,
      unrealised: 0,
      total_pnl: day_pnl_total,
    });

  } catch (err) {
    console.error("❌ ZERODHA MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
