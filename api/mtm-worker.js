// mtm-worker.js (v5 FINAL ZERODHA-PNL MATCHING)
// ---------------------------------------------
// REALISED = FIFO from ALL Zerodha getTrades()
// UNREALISED = (LTP - AvgPrice) * NetQty   (Zerodha method)
// Per-symbol separation (required for accuracy)
// ---------------------------------------------

import { kv, setState } from "./_lib/kv.js";
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
   REALISED PNL PER SYMBOL
------------------------------------------------------ */
async function computeRealisedBySymbol(kc) {
  const trades = await kc.getTrades();

  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp);
    return ta - tb;
  });

  const books = {};
  const realisedMap = {};

  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const price = Number(t.average_price);
    const side = t.transaction_type.toUpperCase();

    if (!books[sym]) books[sym] = [];
    if (!realisedMap[sym]) realisedMap[sym] = 0;

    let result =
      side === "BUY"
        ? fifoBuy(books[sym], qty, price)
        : fifoSell(books[sym], qty, price);

    realisedMap[sym] += result.realised;
    books[sym] = result.book;
  }

  return realisedMap;
}

/* ------------------------------------------------------
   UNREALISED PNL PER SYMBOL
------------------------------------------------------ */
async function computeUnrealisedBySymbol(kc, ltpAll) {
  const pos = await kc.getPositions();
  const net = pos.net || [];
  const map = {};

  for (const p of net) {
    const sym = p.tradingsymbol;
    const qty = Number(p.quantity);
    if (qty === 0) continue;

    const avg = Number(p.average_price);
    const token = Number(p.instrument_token);

    const ltp =
      Number(ltpAll[token]?.last_price) ||
      Number(p.last_price) ||
      avg;

    const u =
      qty > 0
        ? (ltp - avg) * qty
        : (avg - ltp) * Math.abs(qty);

    map[sym] = u;
  }

  return map;
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    const realisedMap = await computeRealisedBySymbol(kc);
    const unrealisedMap = await computeUnrealisedBySymbol(kc, ltpAll);

    let realised = 0;
    let unrealised = 0;

    // Combine both maps
    for (const sym in realisedMap) realised += realisedMap[sym];
    for (const sym in unrealisedMap) unrealised += unrealisedMap[sym];

    const total = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now(),
    });

    console.log("🟢 MTM FINAL:", { realised, unrealised, total_pnl: total });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl: total,
      realisedMap,
      unrealisedMap,
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}
