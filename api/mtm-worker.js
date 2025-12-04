// mtm-worker.js (FINAL FULL DEBUG VERSION)
// ---------------------------------------
// ✔ Reads captures from `trades:YYYYMMDD`
// ✔ Preloads overnight FIFO bucket
// ✔ Performs Zerodha-accurate FIFO realised P&L
// ✔ Computes unrealised P&L from positions + LTP
// ✔ DEBUG logs everywhere

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   FIFO UTILITIES
------------------------------------------------------ */

function fifoSell(book, qty, price) {
  console.log(`\n[FIFO SELL] qty=${qty} price=${price}`);
  let remaining = qty;
  let realised = 0;
  const newBook = [];

  for (const lot of book) {
    console.log("  Checking lot:", lot);
    if (remaining <= 0) {
      newBook.push(lot);
      continue;
    }
    if (lot.side === "BUY") {
      const use = Math.min(remaining, lot.qty);
      const pnl = (price - lot.avg) * use;
      realised += pnl;
      console.log(`  MATCH BUY → SELL: avg=${lot.avg} qty=${use} pnl=${pnl}`);

      if (lot.qty > use) {
        newBook.push({ ...lot, qty: lot.qty - use });
      }
      remaining -= use;
    } else {
      newBook.push(lot);
    }
  }

  if (remaining > 0) {
    console.log(`  Remaining unmatched SELL qty=${remaining}, adding sell lot`);
    newBook.push({ side: "SELL", qty: remaining, avg: price });
  }

  console.log("[FIFO SELL RESULT]", { realised, newBook });
  return { realised, book: newBook };
}

function fifoBuy(book, qty, price) {
  console.log(`\n[FIFO BUY] qty=${qty} price=${price}`);
  let remaining = qty;
  let realised = 0;
  const newBook = [];

  for (const lot of book) {
    console.log("  Checking lot:", lot);
    if (remaining <= 0) {
      newBook.push(lot);
      continue;
    }
    if (lot.side === "SELL") {
      const use = Math.min(remaining, lot.qty);
      const pnl = (lot.avg - price) * use;
      realised += pnl;
      console.log(`  MATCH SELL → BUY: avg=${lot.avg} qty=${use} pnl=${pnl}`);

      if (lot.qty > use) newBook.push({ ...lot, qty: lot.qty - use });
      remaining -= use;
    } else {
      newBook.push(lot);
    }
  }

  if (remaining > 0) {
    console.log(`  Adding new BUY lot qty=${remaining}`);
    newBook.push({ side: "BUY", qty: remaining, avg: price });
  }

  console.log("[FIFO BUY RESULT]", { realised, newBook });
  return { realised, book: newBook };
}

/* ------------------------------------------------------
   LOAD ALL TRADES FROM KV (one-key-per-day)
------------------------------------------------------ */

async function loadCapturedTrades() {
  const dateKey = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const key = `trades:${dateKey}`;

  const trades = (await kv.get(key)) || [];

  console.log("\n===================================================");
  console.log("DEBUG: FULL TRADE LIST FROM KV");
  console.log(JSON.stringify(trades, null, 2));
  console.log("===================================================\n");

  // Sort by timestamp to keep FIFO order correct
  trades.sort((a, b) => a.ts - b.ts);

  return trades;
}

/* ------------------------------------------------------
   FIFO REALISED (including overnight preload)
------------------------------------------------------ */

function computeRealisedFIFO(trades, positions) {
  console.log("\n===== BUILDING FIFO REALISED =====");

  const books = {};
  const realisedMap = {};

  // 1️⃣ Preload overnight lots
  for (const p of positions) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);
    const buyPrice = Number(p.buy_price || p.average_price);

    if (!books[sym]) {
      books[sym] = [];
      realisedMap[sym] = 0;
    }

    if (oq > 0) {
      console.log(
        `\n[PRELOAD OVERNIGHT] ${sym} oq=${oq} @ ${buyPrice}`
      );
      books[sym].push({
        side: "BUY",
        qty: oq,
        avg: buyPrice,
      });
    }
  }

  // 2️⃣ Apply FIFO for today's trades
  for (const t of trades) {
    const sym = t.sym;
    const side = t.side;
    const qty = Number(t.qty);
    const price = Number(t.price);

    if (!books[sym]) {
      books[sym] = [];
      realisedMap[sym] = 0;
    }

    console.log(`\n[FIFO APPLY] ${sym} ${side} ${qty} @ ${price}`);

    const r =
      side === "BUY"
        ? fifoBuy(books[sym], qty, price)
        : fifoSell(books[sym], qty, price);

    realisedMap[sym] += r.realised;
    books[sym] = r.book;
  }

  console.log("\n===== REALISED MAP =====");
  console.log(realisedMap);
  console.log("=========================\n");

  return realisedMap;
}

/* ------------------------------------------------------
   UNREALISED
------------------------------------------------------ */

function computeUnrealised(positions, ltpAll) {
  const unrealisedMap = {};

  console.log("\n===== COMPUTING UNREALISED =====");

  for (const p of positions) {
    const sym = p.tradingsymbol;
    const qty = Number(p.quantity);
    if (qty === 0) continue;

    const avg = Number(p.average_price);
    const token = p.instrument_token;
    const ltp = ltpAll[token]?.last_price || p.last_price || avg;

    const u = qty > 0 ? (ltp - avg) * qty : (avg - ltp) * Math.abs(qty);

    unrealisedMap[sym] = u;

    console.log(`${sym}: qty=${qty} avg=${avg} ltp=${ltp} => U=${u}`);
  }

  console.log("===== UNREALISED MAP =====");
  console.log(unrealisedMap);
  console.log("===========================\n");

  return unrealisedMap;
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();

    const pos = await kc.getPositions();
    const positions = pos.net || [];
    const ltpAll = (await kv.get("ltp:all")) || {};

    console.log("\n============== POSITIONS ==============");
    console.log(JSON.stringify(positions, null, 2));
    console.log("=======================================\n");

    console.log("\n============== LTP ALL ===============");
    console.log(JSON.stringify(ltpAll, null, 2));
    console.log("=======================================\n");

    const trades = await loadCapturedTrades();

    // REALISED
    const realisedMap = computeRealisedFIFO(trades, positions);

    // UNREALISED
    const unrealisedMap = computeUnrealised(positions, ltpAll);

    // TOTALS
    let realised = 0;
    let unrealised = 0;

    for (const k in realisedMap) realised += realisedMap[k];
    for (const k in unrealisedMap) unrealised += unrealisedMap[k];

    const total_pnl = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl,
      mtm_last_update: Date.now()
    });

    console.log("\n🟢 MTM FINAL:", { realised, unrealised, total_pnl });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl,
      realisedMap,
      unrealisedMap
    });

  } catch (err) {
    console.error("\n❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}
