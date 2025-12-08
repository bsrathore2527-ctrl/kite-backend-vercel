// mtm-worker.js (v6 with EXTREME DEBUGGING)
// --------------------------------------------------
// REALISED = FIFO from ALL Zerodha getTrades()
// UNREALISED = Zerodha avg vs FIFO avg (side-by-side logged)
// FULL BOOK BREAKDOWN LOGS ADDED
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

  console.log(`\n[FIFO SELL] Sell ${qty} @ ${price}`);
  console.log("BOOK BEFORE SELL:", JSON.stringify(book));

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "BUY") {
      const take = Math.min(qtyRem, lot.qty);
      const pnl = (price - lot.avg) * take;

      console.log(
        `  MATCH BUY lot -> take=${take} from BUY ${lot.qty} @ ${lot.avg}, realised=${pnl}`
      );

      realised += pnl;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    console.log(`  OPEN NEW SHORT lot: SELL ${qtyRem} @ ${price}`);
    newLots.push({ side: "SELL", qty: qtyRem, avg: price });
  }

  console.log("BOOK AFTER SELL:", JSON.stringify(newLots));
  console.log("REALIZED FROM THIS SELL:", realised);

  return { realised, book: newLots };
}

function fifoBuy(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];

  console.log(`\n[FIFO BUY] Buy ${qty} @ ${price}`);
  console.log("BOOK BEFORE BUY:", JSON.stringify(book));

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "SELL") {
      const take = Math.min(qtyRem, lot.qty);
      const pnl = (lot.avg - price) * take;

      console.log(
        `  MATCH SELL lot -> take=${take} from SELL ${lot.qty} @ ${lot.avg}, realised=${pnl}`
      );

      realised += pnl;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    console.log(`  OPEN NEW LONG lot: BUY ${qtyRem} @ ${price}`);
    newLots.push({ side: "BUY", qty: qtyRem, avg: price });
  }

  console.log("BOOK AFTER BUY:", JSON.stringify(newLots));
  console.log("REALIZED FROM THIS BUY:", realised);

  return { realised, book: newLots };
}

/* ------------------------------------------------------
   REALISED WITH OVERNIGHT
------------------------------------------------------ */

async function computeRealised(kc) {
  const trades = await kc.getTrades();
  console.log("\n===============================");
  console.log("🔍 DEBUG TRADES (RAW):", JSON.stringify(trades, null, 2));

  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp);
    return ta - tb;
  });

  console.log("\n🔍 DEBUG TRADES (SORTED):", JSON.stringify(trades, null, 2));

  const books = {};
  let realised = 0;

  // Preload overnight
  const pos = await kc.getPositions();
  console.log("\n🔍 POSITIONS FOR OVERNIGHT:", JSON.stringify(pos.net, null, 2));

  for (const p of pos.net || []) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);
    if (!oq) continue;

    const buyVal = Number(p.buy_value || 0);
    const dayBuyVal = Number(p.day_buy_value || 0);
    const overnightVal = buyVal - dayBuyVal;
    const avg = oq > 0 ? overnightVal / oq : 0;

    if (!books[sym]) books[sym] = [];
    books[sym].push({ side: "BUY", qty: oq, avg });

    console.log(`  PRELOAD ${sym}: BUY ${oq} @ ${avg}`);
  }

  // FIFO process
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const side = t.transaction_type.toUpperCase();
    const price = Number(t.average_price);

    if (!books[sym]) books[sym] = [];

    console.log(`\n⚙ FIFO PROCESS: ${sym} → ${side} ${qty} @ ${price}`);
    console.log("BOOK ENTERING:", JSON.stringify(books[sym]));

    const result =
      side === "BUY"
        ? fifoBuy(books[sym], qty, price)
        : fifoSell(books[sym], qty, price);

    realised += result.realised;
    books[sym] = result.book;

    console.log("BOOK AFTER:", JSON.stringify(books[sym]));
    console.log("REALIZED (running):", realised);
  }

  console.log("\n📘 FINAL FIFO BOOK STATE:", JSON.stringify(books, null, 2));
  console.log("📗 FINAL REALISED:", realised);

  return realised;
}

/* ------------------------------------------------------
   UNREALISED WITH DEEP LOGGING
------------------------------------------------------ */

async function computeUnrealised(kc, ltpAll) {
  const pos = await kc.getPositions();
  const net = pos.net || [];

  console.log("\n===============================");
  console.log("🔍 ZERODHA POSITIONS:", JSON.stringify(net, null, 2));
  console.log("🔍 KV LTP ALL:", JSON.stringify(ltpAll, null, 2));

  let unreal = 0;

  for (const p of net) {
    const qty = Number(p.quantity);
    if (!qty) continue;

    const avg = Number(p.average_price);
    const token = p.instrument_token;
    const ltp = Number(ltpAll[token]?.last_price) || Number(p.last_price) || 0;

    const u = qty > 0
      ? (ltp - avg) * qty
      : (avg - ltp) * Math.abs(qty);

    unreal += u;

    console.log(
      `\n[UNREALISED CALC] ${p.tradingsymbol}\n` +
      `  Zerodha Qty = ${qty}\n` +
      `  Zerodha Avg = ${avg}\n` +
      `  LTP = ${ltp}\n` +
      `  Unrealised Contribution = ${u}\n`
    );
  }

  console.log("📙 FINAL UNREALISED:", unreal);
  return unreal;
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    console.log("\n\n===============================");
    console.log("🟦 MTM-WORKER START");

    const kc = await instance();
    const ltpAll = (await kv.get("ltp:all")) || {};

    const realised = await computeRealised(kc);
    const unrealised = await computeUnrealised(kc, ltpAll);
    const total = realised + unrealised;

    console.log("\n📣 MTM FINAL:", { realised, unrealised, total });

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now(),
    });

    return res.json({ ok: true, realised, unrealised, total_pnl: total });

  } catch (err) {
    console.error("❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
