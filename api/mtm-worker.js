// mtm-worker.js (v5 FINAL)
// --------------------------------------------------
// REALISED = FIFO from ALL Zerodha getTrades()
// UNREALISED = (LTP - Avg) * Qty using kv("ltp:all")
// Includes FIFO PRELOAD for overnight quantities
// --------------------------------------------------

import { kv } from "./_lib/kv.js";
import { setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   FIFO ENGINE
------------------------------------------------------ */

function fifoSell(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "BUY") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (price - lot.avg) * take;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    newLots.push({ side: "SELL", qty: qtyRem, avg: price });
  }

  return { realised, book: newLots };
}

function fifoBuy(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "SELL") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (lot.avg - price) * take;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    newLots.push({ side: "BUY", qty: qtyRem, avg: price });
  }

  return { realised, book: newLots };
}

/* ------------------------------------------------------
   REALISED PNL WITH OVERNIGHT PRELOAD (PATCHED)
------------------------------------------------------ */

async function computeRealised(kc) {
  const trades = await kc.getTrades();

  console.log("DEBUG TRADES:", JSON.stringify(trades, null, 2));

  // Sort trades chronologically
  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp);
    return ta - tb;
  });

  const books = {};
  let realised = 0;

  /* ------------------------------------------------------
     PRELOAD OVERNIGHT POSITIONS  (THIS IS THE PATCH)
  ------------------------------------------------------ */
  const pos = await kc.getPositions();
  const netPos = pos.net || [];

  for (const p of netPos) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);

    if (!oq) continue;
    if (!books[sym]) books[sym] = [];

    // Extract accurate overnight average:
    // overnight_avg = (buy_value - day_buy_value) / overnight_quantity
    const buyVal = Number(p.buy_value || 0);
    const dayBuyVal = Number(p.day_buy_value || 0);
    const overnightVal = buyVal - dayBuyVal;

    const overnightAvg = oq > 0 ? overnightVal / oq : 0;

    books[sym].push({
      side: "BUY",
      qty: oq,
      avg: overnightAvg,
    });

    console.log(
      `PRELOAD → ${sym}: BUY ${oq} @ ${overnightAvg} (overnight qty)`
    );
  }

  /* ------------------------------------------------------
     PROCESS ALL TRADES USING FIFO
  ------------------------------------------------------ */
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const side = t.transaction_type.toUpperCase();
    const price = Number(t.average_price);

    if (!books[sym]) books[sym] = [];

    console.log(`FIFO PROCESS: ${side} ${qty} @ ${price} for ${sym}`);

    const result =
      side === "BUY"
        ? fifoBuy(books[sym], qty, price)
        : fifoSell(books[sym], qty, price);

    realised += result.realised;
    books[sym] = result.book;

    console.log("BOOK NOW:", books[sym]);
    console.log("REALIZED SO FAR:", realised);
  }

  return realised;
}

/* ------------------------------------------------------
   UNREALISED MTM
------------------------------------------------------ */

async function computeUnrealised(kc, ltpAll) {
  const pos = await kc.getPositions();
  const net = pos.net || [];

  console.log("DEBUG POSITIONS:", JSON.stringify(net, null, 2));
  console.log("DEBUG LTPALL:", JSON.stringify(ltpAll, null, 2));

  let unrealised = 0;

  for (const p of net) {
    const qty = Number(p.quantity);
    if (!qty) continue;

    const avg = Number(p.average_price);
    const token = Number(p.instrument_token);

    const ltp = Number(ltpAll[token]?.last_price) || Number(p.last_price) || 0;

    const u = qty > 0
      ? (ltp - avg) * qty
      : (avg - ltp) * Math.abs(qty);

    unrealised += u;

    console.log(`UNRL: ${p.tradingsymbol} qty=${qty} avg=${avg} ltp=${ltp} → ${u}`);
  }

  return unrealised;
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    const realised = await computeRealised(kc);
    const unrealised = await computeUnrealised(kc, ltpAll);
    const total = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now(),
    });

    console.log("📣 MTM FINAL:", { realised, unrealised, total_pnl: total });

    return res.json({ ok: true, realised, unrealised, total_pnl: total });

  } catch (err) {
    console.error("MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
