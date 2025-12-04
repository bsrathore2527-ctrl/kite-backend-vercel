// mtm-worker.js — FINAL PATCHED VERSION (close_price preload)
// ------------------------------------------------------------
// ✔ FIFO realised using full-day KV trades
// ✔ Overnight FIFO preload uses `close_price` (correct Zerodha logic)
// ✔ Unrealised = (LTP – average_price) × qty
// ✔ No KV explosion (one key per day)
// ✔ Full debug logs for bookkeeping

import { kv, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   FIFO HELPERS
------------------------------------------------------ */

function fifoSell(book, qty, price) {
  console.log(`\n[FIFO SELL] qty=${qty} @ ${price}`);
  let r = 0, rem = qty;
  const out = [];

  for (const lot of book) {
    console.log("  Lot:", lot);
    if (rem <= 0) { out.push(lot); continue; }

    if (lot.side === "BUY") {
      const use = Math.min(rem, lot.qty);
      const pnl = (price - lot.avg) * use;
      r += pnl;
      console.log(`  BUY→SELL match: ${use} @ avg=${lot.avg} pnl=${pnl}`);

      if (lot.qty > use) out.push({ ...lot, qty: lot.qty - use });
      rem -= use;
    } else {
      out.push(lot);
    }
  }

  if (rem > 0) {
    console.log(`  Unmatched SELL qty=${rem} → new SELL lot`);
    out.push({ side: "SELL", qty: rem, avg: price });
  }

  return { realised: r, book: out };
}

function fifoBuy(book, qty, price) {
  console.log(`\n[FIFO BUY] qty=${qty} @ ${price}`);
  let r = 0, rem = qty;
  const out = [];

  for (const lot of book) {
    console.log("  Lot:", lot);
    if (rem <= 0) { out.push(lot); continue; }

    if (lot.side === "SELL") {
      const use = Math.min(rem, lot.qty);
      const pnl = (lot.avg - price) * use;
      r += pnl;
      console.log(`  SELL→BUY match: ${use} @ avg=${lot.avg} pnl=${pnl}`);

      if (lot.qty > use) out.push({ ...lot, qty: lot.qty - use });
      rem -= use;
    } else {
      out.push(lot);
    }
  }

  if (rem > 0) {
    out.push({ side: "BUY", qty: rem, avg: price });
    console.log(`  Adding BUY lot qty=${rem}`);
  }

  return { realised: r, book: out };
}

/* ------------------------------------------------------
   LOAD CAPTURED TRADES (single key)
------------------------------------------------------ */

async function loadCapturedTrades() {
  const dayKey = new Date().toISOString().split("T")[0].replace(/-/g, "");
  const key = `trades:${dayKey}`;
  let arr = (await kv.get(key)) || [];

  console.log("\n=========== CAPTURED TRADES ===========");
  console.log(JSON.stringify(arr, null, 2));
  console.log("=======================================\n");

  arr.sort((a, b) => a.ts - b.ts);
  return arr;
}

/* ------------------------------------------------------
   REALISED PNL WITH FIFO (close_price overnight preload)
------------------------------------------------------ */

function computeRealisedFIFO(trades, positions) {
  const books = {};
  const realisedMap = {};

  console.log("\n========= BUILDING FIFO (REALIZED) =========");

  // 1️⃣ Preload overnight lots using correct close_price
  for (const p of positions) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);
    const closePrice = Number(p.close_price || 0);

    realisedMap[sym] = realisedMap[sym] || 0;
    books[sym] = books[sym] || [];

    if (oq > 0) {
      console.log(
        `[PRELOAD OVERNIGHT] ${sym} qty=${oq} @ close_price=${closePrice}`
      );
      books[sym].push({
        side: "BUY",
        qty: oq,
        avg: closePrice
      });
    }
  }

  // 2️⃣ Apply FIFO with captured trades
  for (const t of trades) {
    const sym = t.sym;
    const qty = Number(t.qty);
    const price = Number(t.price);
    const side = t.side;

    books[sym] = books[sym] || [];
    realisedMap[sym] = realisedMap[sym] || 0;

    console.log(`\n[TRADE] ${sym} ${side} ${qty} @ ${price}`);

    const r = side === "BUY"
      ? fifoBuy(books[sym], qty, price)
      : fifoSell(books[sym], qty, price);

    realisedMap[sym] += r.realised;
    books[sym] = r.book;
  }

  console.log("\n========= REALISED MAP =========");
  console.log(realisedMap);
  console.log("================================\n");

  return realisedMap;
}

/* ------------------------------------------------------
   UNREALISED PNL
------------------------------------------------------ */

function computeUnrealised(positions, ltpAll) {
  const uMap = {};

  console.log("\n========= COMPUTING UNREALISED =========");

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

    uMap[sym] = u;

    console.log(`${sym}: qty=${qty}, avg=${avg}, ltp=${ltp}, U=${u}`);
  }

  console.log("\n========= UNREALISED MAP =========");
  console.log(uMap);
  console.log("==================================\n");

  return uMap;
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

    console.log("\n=========== POSITIONS ===========");
    console.log(JSON.stringify(positions, null, 2));
    console.log("=================================\n");

    console.log("\n=========== LTP ===========");
    console.log(JSON.stringify(ltpAll, null, 2));
    console.log("===========================\n");

    const trades = await loadCapturedTrades();

    const realisedMap = computeRealisedFIFO(trades, positions);
    const unrealisedMap = computeUnrealised(positions, ltpAll);

    let realised = 0, unrealised = 0;

    for (const k in realisedMap) realised += realisedMap[k];
    for (const k in unrealisedMap) unrealised += unrealisedMap[k];

    const total = realised + unrealised;

    await setState({
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: Date.now()
    });

    console.log("\n🟢 MTM FINAL:", {
      realised,
      unrealised,
      total_pnl: total
    });

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl: total,
      realisedMap,
      unrealisedMap
    });

  } catch (err) {
    console.error("\n❌ MTM ERROR:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}
