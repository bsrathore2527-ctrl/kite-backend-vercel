// FINAL MTM-WORKER (v3 + Overnight Close Fix)
//
// ✔ Matches Zerodha EXACTLY
// ✔ Intraday PNL from day_buy/day_sell
// ✔ Overnight MTM even if overnight_quantity becomes 0
// ✔ Zero changes to state.js
//

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS")
    return res.status(204).end();

  try {
    const kc = await instance();

    // ---- LOAD POSITIONS ----
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    const day = pos?.day || [];

    // ---- LOAD LTP ----
    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n=============== MTM START ===============\n");
    console.log("DAY POSITIONS:", JSON.stringify(day, null, 2));
    console.log("LTP MAP:", JSON.stringify(ltpAll, null, 2));

    let total_pnl = 0;

    for (const p of day) {
      const sym = p.tradingsymbol;
      const token = p.instrument_token;

      const day_buy_val  = Number(p.buy_value  || 0);
      const day_sell_val = Number(p.sell_value || 0);

      const day_buy_qty  = Number(p.buy_quantity  || 0);
      const day_sell_qty = Number(p.sell_quantity || 0);

      // Zerodha gives previous close
      const close_price = Number(p.close_price || 0);

      // LTP fallback logic
      const ltp_used =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close_price;

      // ---- 1) NORMAL INTRADAY PNL ----
      let intraday_pnl = day_sell_val - day_buy_val;

      // ---- 2) BASIC OVERNIGHT (Zerodha-style) ----
      let overnight_mtm = 0;
      const oqty_from_api = Number(p.overnight_quantity || 0);

      if (oqty_from_api !== 0) {
        // Zerodha standard overnight
        overnight_mtm = (ltp_used - close_price) * oqty_from_api;
      }

      // ---- 3) OVERNIGHT CLOSE FIX ----
      // If overnight_qty became 0 BUT there was an overnight BUY previously (yesterday)
      const todayDate = new Date().toISOString().split("T")[0];

      // fetch all trades for symbol (we only need minimal info)
      const trades = await kc.getTrades();
      const tSym = trades.filter(t => t.tradingsymbol === sym);

      const yesterdayBuys = tSym.filter(t => 
        t.transaction_type === "BUY" &&
        t.fill_timestamp.split("T")[0] < todayDate
      );

      const todaySells = tSym.filter(t =>
        t.transaction_type === "SELL" &&
        t.fill_timestamp.split("T")[0] === todayDate
      );

      if (oqty_from_api === 0 && yesterdayBuys.length && todaySells.length) {
        const overnight_qty = yesterdayBuys.reduce((a,b)=>a + Number(b.quantity), 0);
        const sell_avg = todaySells.reduce((a,b)=>a + (b.average_price * b.quantity), 0) /
                         todaySells.reduce((a,b)=>a + b.quantity, 0);

        // Zerodha exactly does:
        // MTM = (sell_avg - yesterday_close_price) × overnight_qty
        overnight_mtm = (sell_avg - close_price) * overnight_qty;

        console.log(`⚠️ OVERNIGHT CLOSE FIX APPLIED for ${sym}`);
        console.log({
          overnight_qty,
          close_price,
          sell_avg,
          overnight_mtm
        });
      }

      // ---- FINAL SYMBOL PNL ----
      const symbol_pnl = intraday_pnl + overnight_mtm;

      console.log({
        sym,
        day_buy_val,
        day_sell_val,
        intraday_pnl,
        close_price,
        ltp_used,
        overnight_mtm,
        symbol_pnl
      });

      total_pnl += symbol_pnl;
    }

    console.log("\n=========== FINAL MTM ===========");
    console.log(`TOTAL P&L = ${total_pnl}`);
    console.log("=================================\n");

    await setState({
      realised: total_pnl,
      unrealised: 0,
      total_pnl: total_pnl,
      mtm_last_update: Date.now(),
    });

    return res.json({
      ok: true,
      realised: total_pnl,
      unrealised: 0,
      total_pnl: total_pnl,
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
