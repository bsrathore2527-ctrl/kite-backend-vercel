// mtm-worker.js — Zerodha P&L Exact Match (sell_value - buy_value)
// ---------------------------------------------------------------
// Matches Zerodha Positions "P&L" exactly:
//   symbol_pnl = sell_value - buy_value
//   day_pnl_total = sum(symbol_pnl)
// And writes:
//   realised   = day_pnl_total
//   unrealised = 0
//   total_pnl  = day_pnl_total

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    // LTP not required for P&L, but logged for reference
    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n\n=============================");
    console.log("🔵 ZERODHA-MTM (VALUE P&L) START");
    console.log("=============================\n");

    console.log("DEBUG POSITIONS (net):");
    console.log(JSON.stringify(net, null, 2));

    console.log("\nDEBUG LTP ALL:");
    console.log(JSON.stringify(ltpAll, null, 2));

    let day_pnl_total = 0;

    for (const p of net) {
      const sym   = p.tradingsymbol;
      const token = p.instrument_token;

      const buyVal  = Number(p.buy_value  || 0);
      const sellVal = Number(p.sell_value || 0);
      const oqty    = Number(p.overnight_quantity || 0);
      const close   = Number(p.close_price || 0);
      const last    =
        Number(ltpAll[token]?.last_price) ||
        Number(p.last_price) ||
        close;

      console.log("\n----------------------------");
      console.log(`🔸 SYMBOL: ${sym}`);
      console.log("----------------------------");
      console.log("Raw Zerodha position fields:");
      console.log({
        sym,
        buy_value: buyVal,
        sell_value: sellVal,
        pnl_from_broker: p.pnl,
        value_from_broker: p.value,
        oqty,
        close_price: close,
        last_price: p.last_price,
        ltp_from_ticker: ltpAll[token]?.last_price ?? null,
      });

      // Zerodha-style P&L: simply sell_value - buy_value
      const symbol_pnl = sellVal - buyVal;

      console.log(`➡️ Calc symbol_pnl = sell_value - buy_value`);
      console.log(`   = ${sellVal} - ${buyVal} = ${symbol_pnl}`);

      // Compare with broker-reported pnl for sanity
      if (typeof p.pnl !== "undefined") {
        const brokerPnl = Number(p.pnl);
        if (Math.abs(brokerPnl - symbol_pnl) > 0.01) {
          console.warn(
            `⚠️ MISMATCH with broker pnl for ${sym}: calc=${symbol_pnl}, broker=${brokerPnl}`
          );
        } else {
          console.log(
            `✅ Matches broker pnl (${brokerPnl}) for ${sym}`
          );
        }
      }

      day_pnl_total += symbol_pnl;
    }

    console.log("\n=============================");
    console.log("🔵 FINAL ZERODHA DAY P&L (VALUE)");
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

    console.log("\n🔵 ZERODHA-MTM (VALUE P&L) END\n\n");

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
