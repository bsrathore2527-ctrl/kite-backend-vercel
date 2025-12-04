// FINAL ZERODHA-ACCURATE MTM ENGINE
// ---------------------------------
// Matches Zerodha exactly: FIFO + MTM snapshot

import { kite } from "../../lib/kite.js";   // your kite instance
import { kv } from "@vercel/kv";            // only used for snapshot (optional)
import dayjs from "dayjs";

export default async function handler(req, res) {
  try {
    console.log("🚀 MTM WORKER START");

    // Fetch all needed data
    const trades = await kite.getTrades();
    const positions = await kite.getPositions();
    const ltpAll = await kv.get("ltp:all") || {};

    console.log("DEBUG TRADES:", JSON.stringify(trades, null, 2));
    console.log("DEBUG POSITIONS:", JSON.stringify(positions.net, null, 2));
    console.log("DEBUG LTP:", JSON.stringify(ltpAll, null, 2));

    // Build per-symbol trade buckets
    const symbolTrades = {};
    for (let t of trades) {
      const sym = t.tradingsymbol;
      if (!symbolTrades[sym]) symbolTrades[sym] = [];
      symbolTrades[sym].push({
        type: t.transaction_type,
        price: Number(t.average_price),
        qty: Number(t.quantity)
      });
    }

    let total_pnl = 0;
    const debug = [];

    for (let pos of positions.net) {
      const sym = pos.tradingsymbol;
      const token = pos.instrument_token;

      // LTP from ticker or fallback to Zerodha field
      const ltp_used = ltpAll[token]?.last_price ?? pos.last_price;

      const snapshot_qty = Number(pos.overnight_quantity);
      const snapshot_close = Number(pos.close_price);

      const yes_OQ = snapshot_qty;   // old carry-forward
      const tradesToday = symbolTrades[sym] || [];

      // FIFO queues
      let fifo = [];
      let realized = 0;

      // Load snapshot FIFO if overnight qty exists
      if (yes_OQ > 0) {
        fifo.push({
          qty: yes_OQ,
          price: pos.buy_price || pos.average_price   // best possible buy ref
        });
      }

      // Apply today's trades FIFO
      for (let t of tradesToday) {
        if (t.type === "BUY") {
          fifo.push({ qty: t.qty, price: t.price });
        } else if (t.type === "SELL") {
          let sellQty = t.qty;
          while (sellQty > 0 && fifo.length > 0) {
            let bucket = fifo[0];
            const matchQty = Math.min(sellQty, bucket.qty);
            realized += (t.price - bucket.price) * matchQty;
            bucket.qty -= matchQty;
            sellQty -= matchQty;
            if (bucket.qty === 0) fifo.shift();
          }
        }
      }

      // Unrealized MTM only for leftover snapshot qty
      let remOvernightQty = 0;
      if (yes_OQ > 0 && fifo.length > 0) {
        remOvernightQty = fifo[0].qty; // only snapshot bucket left
      }

      let unrealised = 0;
      if (remOvernightQty > 0) {
        unrealised = (ltp_used - snapshot_close) * remOvernightQty;
      }

      const symbol_pnl = realized + unrealised;
      total_pnl += symbol_pnl;

      debug.push({
        sym,
        ltp_used,
        snapshot_qty,
        snapshot_close,
        realized,
        unrealised,
        symbol_pnl
      });

      console.log("P&L DEBUG:", debug[debug.length-1]);
    }

    console.log("🟢 FINAL MTM:", total_pnl);

    return res.json({
      ok: true,
      total_pnl,
      details: debug
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}
