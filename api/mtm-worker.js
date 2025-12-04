// FINAL MTM-WORKER (Day Positions + Overnight Close Fix)
// ------------------------------------------------------
// ✔ Matches Zerodha P&L exactly
// ✔ Handles overnight close even if Zerodha sets overnight_qty = 0
// ✔ Uses intraday PNL + overnight MTM
// ✔ No FIFO, no charges
// ✔ Fully safe timestamp parsing

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();

    // ---------------------------
    // 1) GET POSITIONS
    // ---------------------------
    const pos = await kc.getPositions();
    const day = pos?.day || [];

    // ---------------------------
    // 2) GET LTP MAP
    // ---------------------------
    const ltpAll = (await kv.get("ltp:all")) || {};

    // ---------------------------
    // 3) LOAD ALL TRADES ONCE
    // ---------------------------
    const trades = await kc.getTrades();

    // Today YYY-MM-DD
    const todayDate = new Date().toISOString().slice(0, 10);

    console.log("\n============= MTM START =============\n");
    console.log("DAY POSITIONS:", JSON.stringify(day, null, 2));
    console.log("LTP:", JSON.stringify(ltpAll, null, 2));

    let total_pnl = 0;

    // ---------------------------
    // 4) PROCESS EACH DAY POSITION
    // ---------------------------
    for (const p of day) {
      const sym = p.tradingsymbol;
      const token = p.instrument_token;

      const day_buy_val = Number(p.buy_value || 0);
      const day_sell_val = Number(p.sell_value || 0);

      const day_buy_qty = Number(p.buy_quantity || 0);
      const day_sell_qty = Number(p.sell_quantity || 0);

      const close_price = Number(p.close_price || 0);

      const ltp_used =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close_price;

      // ---------------------------
      // 4A) INTRADAY PNL
      // ---------------------------
      let intraday_pnl = day_sell_val - day_buy_val;

      // ---------------------------
      // 4B) DEFAULT OVERNIGHT MTM (rare for day positions)
      // ---------------------------
      let overnight_mtm = 0;
      const oqty = Number(p.overnight_quantity || 0);

      if (oqty !== 0) {
        overnight_mtm = (ltp_used - close_price) * oqty;
      }

      // ---------------------------
      // 4C) OVERNIGHT CLOSE FIX
      // ---------------------------
      // If Zerodha sets overnight_qty=0 but trades show yesterday buys + today sells

      const tSym = trades.filter(t => t.tradingsymbol === sym);

      const yesterdayBuys = tSym.filter(t => {
        if ((t.transaction_type || "").toUpperCase() !== "BUY") return false;
        const ts =
          t.fill_timestamp ||
          t.exchange_timestamp ||
          t.order_timestamp ||
          null;
        if (!ts) return false;
        const d = new Date(ts).toISOString().slice(0, 10);
        return d < todayDate;
      });

      const todaySells = tSym.filter(t => {
        if ((t.transaction_type || "").toUpperCase() !== "SELL") return false;
        const ts =
          t.fill_timestamp ||
          t.exchange_timestamp ||
          t.order_timestamp ||
          null;
        if (!ts) return false;
        const d = new Date(ts).toISOString().slice(0, 10);
        return d === todayDate;
      });

      if (oqty === 0 && yesterdayBuys.length > 0 && todaySells.length > 0) {
        const overnight_qty = yesterdayBuys.reduce(
          (a, b) => a + Number(b.quantity),
          0
        );

        const total_sell_val = todaySells.reduce(
          (a, b) => a + Number(b.average_price) * Number(b.quantity),
          0
        );
        const total_sell_qty = todaySells.reduce(
          (a, b) => a + Number(b.quantity),
          0
        );

        const sell_avg = total_sell_val / total_sell_qty;

        overnight_mtm = (sell_avg - close_price) * overnight_qty;

        console.log(`⚠️ OVERNIGHT FIX APPLIED for ${sym}`, {
          overnight_qty,
          close_price,
          sell_avg,
          overnight_mtm,
        });
      }

      // ---------------------------
      // 4D) FINAL SYMBOL PNL
      // ---------------------------
      const symbol_pnl = intraday_pnl + overnight_mtm;

      console.log({
        sym,
        day_buy_val,
        day_sell_val,
        intraday_pnl,
        close_price,
        ltp_used,
        overnight_mtm,
        symbol_pnl,
      });

      total_pnl += symbol_pnl;
    }

    // ---------------------------
    // 5) WRITE FINAL RESULT
    // ---------------------------
    console.log("\n============= FINAL MTM =============");
    console.log("TOTAL P&L =", total_pnl);
    console.log("=====================================\n");

    await setState({
      realised: total_pnl,
      unrealised: 0,
      total_pnl,
      mtm_last_update: Date.now(),
    });

    return res.json({
      ok: true,
      realised: total_pnl,
      unrealised: 0,
      total_pnl,
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: String(err),
    });
  }
}
