// mtm-worker.js (FINAL ZERODHA MATCHING VERSION)
// -----------------------------------------------
// ✔ FIFO Realised using Trades + Overnight BUY preload
// ✔ Unrealised = (LTP – AvgPrice) × Qty
// ✔ Exact Zerodha matching logic
// ✔ Per-symbol calculation

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   FIFO FUNCTIONS
------------------------------------------------------ */

function fifoSell(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  const newLots = [];

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
  const newLots = [];

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
   FIFO REALISED PNL (including overnight preload)
------------------------------------------------------ */
async function computeRealisedBySymbol(kc, positions) {
  const trades = await kc.getTrades();

  // sort trades by actual time
  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp);
    return ta - tb;
  });

  const realisedMap = {};
  const books = {};

  // 1️⃣ PRELOAD OVERNIGHT FIFO BUCKETS
  for (const p of positions) {
    const sym = p.tradingsymbol;
    const oqty = Number(p.overnight_quantity || 0);
    const buyPrice = Number(p.buy_price || p.average_price);

    if (oqty > 0) {
      books[sym] = [{
        side: "BUY",
        qty: oqty,
        avg: buyPrice
      }];
      realisedMap[sym] = 0;
    }
  }

  // 2️⃣ APPLY TODAY’S TRADES FIFO
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const price = Number(t.average_price);
    const side = t.transaction_type.toUpperCase();

    if (!books[sym]) {
      books[sym] = [];
      realisedMap[sym] = 0;
    }

    const result = side === "BUY"
      ? fifoBuy(books[sym], qty, price)
      : fifoSell(books[sym], qty, price);

    realisedMap[sym] += result.realised;
    books[sym] = result.book;
  }

  return realisedMap;
}

/* ------------------------------------------------------
   UNREALISED PNL BY SYMBOL (Zerodha method)
------------------------------------------------------ */

async function computeUnrealisedBySymbol(positions, ltpAll) {
  const unrealisedMap = {};

  for (const p of positions) {
    const sym = p.tradingsymbol;
    const qty = Number(p.quantity);

    if (qty === 0) continue;

    const avg = Number(p.average_price);
    const token = p.instrument_token;
    const ltp = ltpAll[token]?.last_price || p.last_price || avg;

    const u = qty > 0
      ? (ltp - avg) * qty
      : (avg - ltp) * Math.abs(qty);

    unrealisedMap[sym] = u;
  }

  return unrealisedMap;
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    const pos = await kc.getPositions();
    const positions = pos.net || [];

    // FIFO REALISED
    const realisedMap = await computeRealisedBySymbol(kc, positions);

    // POSITION-BASED UNREALISED
    const unrealisedMap = await computeUnrealisedBySymbol(positions, ltpAll);

    // TOTALS
    let realised = 0;
    let unrealised = 0;

    for (const sym in realisedMap) realised += realisedMap[sym];
    for (const sym in unrealisedMap) unrealised += unrealisedMap[sym];

    const total_pnl = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl,
      mtm_last_update: Date.now()
    });

    console.log("🟢 MTM FINAL:", { realised, unrealised, total_pnl });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl,
      realisedMap,
      unrealisedMap
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}
