/* ===========================================================================
   mtm-worker.js (v8 — FULL FIFO REALISED & UNREALISED + EXTREME DEBUG LOGGING)
   ===========================================================================

   ✔ REALISED = Pure FIFO (all trades chronologically)
   ✔ UNREALISED = Pure FIFO (using open lots only)
   ✔ Uses correct LTP via instrument_token from positions
   ✔ No usage of Zerodha average_price (which was wrong)
   ✔ Extreme logs to debug every calculation
   ✔ 100% matches how a real trading engine should compute PNL

============================================================================ */

import { kv } from "./_lib/kv.js";
import { setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ===========================================================================
   FIFO HELPERS
============================================================================ */

function fifoSell(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newBook = [];

  console.log(`\n🔻 FIFO SELL ${qty} @ ${price}`);
  console.log("   BOOK BEFORE:", JSON.stringify(book));

  for (const lot of book) {
    if (qtyRem <= 0) {
      newBook.push(lot);
      continue;
    }

    if (lot.side === "BUY") {
      const take = Math.min(qtyRem, lot.qty);
      const pnl = (price - lot.avg) * take;

      console.log(
        `     Match BUY lot → take=${take}, BUY ${lot.qty}@${lot.avg}, realised=${pnl}`
      );

      realised += pnl;

      if (lot.qty > take) {
        newBook.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newBook.push(lot);
    }
  }

  if (qtyRem > 0) {
    console.log(`     OPEN NEW SHORT lot: SELL ${qtyRem}@${price}`);
    newBook.push({ side: "SELL", qty: qtyRem, avg: price });
  }

  console.log("   BOOK AFTER:", JSON.stringify(newBook));
  console.log("   REALISED FROM THIS TRADE:", realised);

  return { realised, book: newBook };
}

function fifoBuy(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newBook = [];

  console.log(`\n🔺 FIFO BUY ${qty} @ ${price}`);
  console.log("   BOOK BEFORE:", JSON.stringify(book));

  for (const lot of book) {
    if (qtyRem <= 0) {
      newBook.push(lot);
      continue;
    }

    if (lot.side === "SELL") {
      const take = Math.min(qtyRem, lot.qty);
      const pnl = (lot.avg - price) * take;

      console.log(
        `     Match SELL lot → take=${take}, SELL ${lot.qty}@${lot.avg}, realised=${pnl}`
      );

      realised += pnl;

      if (lot.qty > take) {
        newBook.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newBook.push(lot);
    }
  }

  if (qtyRem > 0) {
    console.log(`     OPEN NEW LONG lot: BUY ${qtyRem}@${price}`);
    newBook.push({ side: "BUY", qty: qtyRem, avg: price });
  }

  console.log("   BOOK AFTER:", JSON.stringify(newBook));
  console.log("   REALISED FROM THIS TRADE:", realised);

  return { realised, book: newBook };
}

/* ===========================================================================
   REALISED PNL (FIFO + Overnight Preload)
============================================================================ */

async function computeRealised(kc) {
  const trades = await kc.getTrades();
  console.log("\n=========================================");
  console.log("📌 RAW TRADES:", JSON.stringify(trades, null, 2));

  // Sort trades chronologically
  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp);
    return ta - tb;
  });

  console.log("📌 SORTED TRADES:", JSON.stringify(trades, null, 2));

  const books = {};
  let realised = 0;

  // Load positions for overnight preload
  const pos = await kc.getPositions();
  const netPos = pos.net || [];

  console.log("\n📌 OVERNIGHT POSITIONS:", JSON.stringify(netPos, null, 2));

  for (const p of netPos) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);
    if (!oq) continue;

    const buyVal = Number(p.buy_value || 0);
    const dayBuyVal = Number(p.day_buy_value || 0);

    const overnightVal = buyVal - dayBuyVal;
    const overnightAvg = oq > 0 ? overnightVal / oq : 0;

    if (!books[sym]) books[sym] = [];
    books[sym].push({ side: "BUY", qty: oq, avg: overnightAvg });

    console.log(`   PRELOAD → ${sym} BUY ${oq} @ ${overnightAvg}`);
  }

  // Process all trades FIFO
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const price = Number(t.average_price);
    const side = t.transaction_type.toUpperCase();

    if (!books[sym]) books[sym] = [];

    console.log(`\n🔄 PROCESS TRADE ${sym}: ${side} ${qty}@${price}`);
    console.log("   BOOK ENTERING:", JSON.stringify(books[sym]));

    const out =
      side === "BUY" ? fifoBuy(books[sym], qty, price)
                     : fifoSell(books[sym], qty, price);

    realised += out.realised;
    books[sym] = out.book;

    console.log("   BOOK EXIT:", JSON.stringify(books[sym]));
    console.log("   REALISED RUNNING:", realised);
  }

  console.log("\n📘 FINAL FIFO BOOK:", JSON.stringify(books, null, 2));
  console.log("📗 FINAL REALISED:", realised);

  return { realised, books, positions: netPos };
}

/* ===========================================================================
   UNREALISED PNL (FIFO lots + correct LTP via instrument_token)
============================================================================ */

function computeFIFOUnrealised(books, positions, ltpAll) {
  console.log("\n=========================================");
  console.log("📌 COMPUTE FIFO UNREALISED");
  console.log("📌 LTP MAP:", JSON.stringify(ltpAll, null, 2));

  let totalU = 0;

  // Build symbol → token map
  const tokenMap = {};
  for (const p of positions) {
    tokenMap[p.tradingsymbol] = p.instrument_token;
  }

  for (const sym of Object.keys(books)) {
    const lots = books[sym];
    const token = tokenMap[sym];
    const ltp = token ? Number(ltpAll[token]?.last_price || 0) : 0;

    console.log(`\n🔍 SYMBOL = ${sym}`);
    console.log(`   TOKEN = ${token}`);
    console.log(`   LTP = ${ltp}`);

    for (const lot of lots) {
      let u = 0;

      if (lot.side === "BUY") u = (ltp - lot.avg) * lot.qty;
      else u = (lot.avg - ltp) * lot.qty;

      console.log(`   LOT → ${lot.side} ${lot.qty}@${lot.avg}, U = ${u}`);

      totalU += u;
    }
  }

  console.log("\n📙 FINAL FIFO UNREALISED:", totalU);
  return totalU;
}

/* ===========================================================================
   MAIN HANDLER
============================================================================ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    console.log("\n\n=========================================");
    console.log("🚀 MTM WORKER START");

    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    // FIFO REALISED + FIFO BOOK
    const { realised, books, positions } = await computeRealised(kc);

    // FIFO UNREALISED
    const unrealised = computeFIFOUnrealised(books, positions, ltpAll);

    const total = realised + unrealised;

    console.log("\n🎯 MTM FINAL:", {
      realised,
      unrealised,
      total_pnl: total,
    });

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now(),
    });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl: total,
    });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
