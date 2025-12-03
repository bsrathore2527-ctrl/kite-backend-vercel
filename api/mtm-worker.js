// mtm-worker.js
// ----------------------------------------------
// REALISED PnL = Zerodha getTrades() using fresh FIFO
// UNREALISED PnL = (LTP - AVG) * Qty using kv("ltp:all")
// No baselines, no enforce-trades FIFO, no guardian:book
// ----------------------------------------------

import { kv } from "./_lib/kv.js";
import { getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   SIMPLE & CORRECT FIFO ENGINE
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
   REALISED PNL FROM Zerodha getTrades() (TODAY ONLY)
------------------------------------------------------ */

async function computeTodayRealised(kc) {
  const trades = await kc.getTrades();
  const today = new Date().toISOString().slice(0, 10);

  const todayTrades = trades.filter(t => {
    const d = (t.order_timestamp || t.exchange_timestamp || "").slice(0, 10);
    return d === today;
  });

  todayTrades.sort((a, b) =>
    new Date(a.order_timestamp) - new Date(b.order_timestamp)
  );

  const books = {}; // symbol → FIFO lots
  let realised = 0;

  for (const t of todayTrades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity || 0);
    const side = (t.transaction_type || "").toUpperCase();
    const price = Number(t.average_price || t.price || 0);

    if (!books[sym]) books[sym] = [];

    let result;
    if (side === "BUY") {
      result = fifoBuy(books[sym], qty, price);
    } else {
      result = fifoSell(books[sym], qty, price);
    }

    realised += result.realised;
    books[sym] = result.book;
  }

  return realised;
}

/* ------------------------------------------------------
   UNREALISED PNL FROM ltp:all + Zerodha Positions
------------------------------------------------------ */

async function computeUnrealised(kc, ltpAll) {
  const pos = await kc.getPositions();
  const net = pos?.net || [];

  let unrealised = 0;

  for (const p of net) {
    const qty = Number(p.net_quantity);
    if (!qty) continue;

    const avg = Number(p.average_price || 0);
    const token = Number(p.instrument_token);

    const ltp =
      Number(ltpAll[token]?.last_price) ||
      Number(p.last_price) ||
      0;

    if (qty > 0) {
      unrealised += (ltp - avg) * qty;
    } else {
      unrealised += (avg - ltp) * Math.abs(qty);
    }
  }

  return unrealised;
}

/* ------------------------------------------------------
   MAIN MTM WORKER
------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    // Compute realised from clean FIFO on today's trades
    const realised = await computeTodayRealised(kc);

    // Compute unrealised from ltp:all + positions
    const unrealised = await computeUnrealised(kc, ltpAll);

    const total = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now()
    });

    console.log("🟢 MTM FINAL:", {
      realised,
      unrealised,
      total_pnl: total
    });

    return res.json({ ok: true, realised, unrealised, total_pnl: total });

  } catch (err) {
    console.error("MTM worker error:", err?.message || err);
    await setState({
      mtm_error: String(err),
      mtm_last_error_at: Date.now()
    });
    return res.status(500).json({ ok: false, error: String(err) });
  }
      }
