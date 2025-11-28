// enforce-trades.js (COMPLETE VERSION)
// ONE-ORDER = ONE-TRADE (Mode B: process only when order fully filled)
// MTM-only system (no realised stored in risk state)
// FIFO used only for book integrity
// sellbook MTM-only
// consecutive-loss MTM only (only on SELL)

import { kv, getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ----------------------------- Timestamp Normalization ----------------------------- */
function normalizeTs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return String(ts).length === 10 ? ts * 1000 : ts;
  }
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return String(n).length === 10 ? n * 1000 : n;
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

/* ----------------------------- KV Keys ----------------------------- */
const LAST_TRADE_KEY = "guardian:last_trade_ts";
const BOOK_PREFIX = "guardian:book:";
const TRADEBOOK_KEY = "guardian:tradebook";
const SELLBOOK_KEY = "guardian:sellbook";

/* ------------------------------ Helpers ------------------------------ */
async function getLastProcessedTs() {
  return Number(await kv.get(LAST_TRADE_KEY) || 0);
}

async function setLastProcessedTs(ts) {
  await kv.set(LAST_TRADE_KEY, Number(ts));
}

async function getBook(sym) {
  return (await kv.get(BOOK_PREFIX + sym)) || { instrument: sym, lots: [], net_qty: 0 };
}

async function setBook(sym, book) {
  await kv.set(BOOK_PREFIX + sym, book);
}

/* ------------------------------ Tradebook ------------------------------ */
async function appendToTradebook(t) {
  const raw = await kv.get(TRADEBOOK_KEY);
  const arr = Array.isArray(raw) ? raw : [];

  const ms = normalizeTs(t.ts) || Date.now();

  arr.unshift({
    ts: ms,
    iso_date: new Date(ms).toISOString(),
    tradingsymbol: t.tradingsymbol,
    qty: t.quantity,
    price: t.price,
    side: t.transaction_type,
    raw: t
  });

  if (arr.length > 200) arr.length = 200;
  await kv.set(TRADEBOOK_KEY, arr);
}

/* ------------------------------ FIFO Logic ------------------------------ */
function matchSell(book, qty, price, tradeId, ts) {
  let q = qty;
  const newLots = [];

  for (let lot of book.lots) {
    if (q <= 0) { newLots.push(lot); continue; }

    if (lot.side === "BUY") {
      const avail = Math.abs(lot.qty);
      const take = Math.min(avail, q);

      lot.qty -= take;
      q -= take;

      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }

  if (q > 0) {
    newLots.push({ qty: -q, avg_price: price, side: "SELL", open_ts: ts });
  }

  const netQty = newLots.reduce((s, l) =>
    s + (l.side === "BUY" ? l.qty : -Math.abs(l.qty)), 0);

  return { updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

function matchBuy(book, qty, price, tradeId, ts) {
  let q = qty;
  const newLots = [];

  for (let lot of book.lots) {
    if (q <= 0) { newLots.push(lot); continue; }

    if (lot.side === "SELL") {
      const avail = Math.abs(lot.qty);
      const take = Math.min(avail, q);

      lot.qty += take;
      q -= take;

      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }

  if (q > 0) {
    newLots.push({ qty, avg_price: price, side: "BUY", open_ts: ts });
  }

  const netQty = newLots.reduce((s, l) =>
    s + (l.side === "BUY" ? l.qty : -Math.abs(l.qty)), 0);

  return { updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

/* ------------------------------ Cancel Helpers ------------------------------ */
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s === "PENDING";
    });

    let cancelled = 0;
    for (const o of pending) {
      try {
        await kc.cancelOrder(o.variety || "regular", o.order_id);
        cancelled++;
      } catch {}
    }
    return cancelled;
  } catch {
    return 0;
  }
}

async function squareOffAll(kc) {
  try {
    const snap = await kv.get("positions_live");
    const net = snap?.net || [];
    let sq = 0;

    for (const p of net) {
      const qty = Number(p.net_quantity ?? 0);
      if (!qty) continue;

      const side = qty > 0 ? "SELL" : "BUY";

      await kc.placeOrder("regular", {
        exchange: p.exchange || "NSE",
        tradingsymbol: p.tradingsymbol,
        transaction_type: side,
        quantity: Math.abs(qty),
        order_type: "MARKET",
        product: p.product || "MIS",
        validity: "DAY"
      });
      sq++;
    }
    return sq;
  } catch {
    return 0;
  }
}

/* ------------------------------ MAIN HANDLER ------------------------------ */
export default async function handler(req, res) {
  try {
    const kc = await instance();

    /* ------------------------------ Fetch orders ------------------------------ */
    const trades = await kc.getTrades(); // Fills, not grouped
    const orders = await kc.getOrders(); // Needed to detect COMPLETE

    await setState({
      kite_status: "ok",
      kite_last_ok_at: Date.now(),
      kite_error_message: null
    });

    const lastTs = await getLastProcessedTs();

    /* ------------------------------ GROUP FILLS BY ORDER-ID (MODE B) ------------------------------ */
    const grouped = {};

    for (const f of trades) {
      const oid = f.order_id;
      if (!oid) continue;

      const status = (orders.find(o => o.order_id === oid)?.status || "").toUpperCase();
      if (status !== "COMPLETE") continue; // Mode B → process only after full fill

      if (!grouped[oid]) {
        grouped[oid] = {
          order_id: oid,
          tradingsymbol: f.tradingsymbol,
          transaction_type: (f.transaction_type || "").toUpperCase(),
          total_qty: 0,
          weighted_sum: 0,
          ts: normalizeTs(f.timestamp) || Date.now()
        };
      }

      const qty = Math.abs(Number(f.quantity || 0));
      const price = Number(f.price || 0);

      grouped[oid].total_qty += qty;
      grouped[oid].weighted_sum += qty * price;
      grouped[oid].ts = Math.max(grouped[oid].ts, normalizeTs(f.timestamp) || Date.now());
    }

    /* ------------------------------ Convert grouped to trade list ------------------------------ */
    const finalTrades = [];
    for (const oid in grouped) {
      const g = grouped[oid];
      const avgPrice = g.weighted_sum / g.total_qty;

      finalTrades.push({
        order_id: oid,
        tradingsymbol: g.tradingsymbol,
        transaction_type: g.transaction_type,
        quantity: g.total_qty,
        price: avgPrice,
        ts: g.ts
      });
    }

    /* ------------------------------ Filter new trades ------------------------------ */
    const newTrades = finalTrades.filter(t => t.ts > lastTs).sort((a, b) => a.ts - b.ts);

    let newest = lastTs;

    /* ------------------------------ PROCESS NEW TRADES ------------------------------ */
    for (const t of newTrades) {
      newest = Math.max(newest, t.ts);

      await appendToTradebook(t);

      const sym = t.tradingsymbol;
      const qty = Math.abs(t.quantity);
      const price = Number(t.price);
      const side = t.transaction_type;

      let book = await getBook(sym);

      const result = (
        side === "SELL"
          ? matchSell(book, qty, price, t.order_id, t.ts)
          : matchBuy(book, qty, price, t.order_id, t.ts)
      );

      await setBook(sym, result.updatedBook);

      /* ------------------------------ SELLBOOK (MTM) ------------------------------ */
      if (side === "SELL") {
        const mtmObj = await kv.get("live:mtm") || {};
        const sellMtmNum = Number(mtmObj.unrealised ?? mtmObj.total ?? 0);

        const sb = (await kv.get(SELLBOOK_KEY)) || {};
        sb[sym] = {
          qty,
          price,
          time: t.ts,
          mtm: sellMtmNum
        };
        await kv.set(SELLBOOK_KEY, sb);

        /* ------------------------------ CONSECUTIVE LOSS ------------------------------ */
        const state = await getState();
        const prevMTM = Number(state.last_sell_mtm ?? state.start_day_mtm ?? 0);
        const sellMtmNum = Number(sellMtm);
         let nextCL = Number(state.consecutive_losses ?? 0);

    // loss if new sell MTM < previous sell MTM
    if (sellMtmNum < prevMTM) {
        nextCL += 1;
    } else {
        nextCL = 0;
    }
        console.log("ConsecutiveLossCheck", {
          prevMTM,
          sellMtmNum,
          nextCL
        });
    // save back to KV
    await setState({
        consecutive_losses: nextCL,
        last_sell_mtm: sellMtmNum
      });
      }
    
        // UPDATE LAST TRADE TIME (for admin.html)
        await setState({
       last_trade_time: t.ts
     });
    }
    if (newest > lastTs) await setLastProcessedTs(newest);

    /* ------------------------------ LOSS-FLOOR USING MTM ------------------------------ */
    const mtmObj = await kv.get("live:mtm") || {};
    const liveMTM = Number(mtmObj.total ?? 0);

    const state = await getState();
    const totalPnl = liveMTM;

    let maxLossAbs = Number(state.max_loss_abs ?? 0);
    if (!maxLossAbs) {
      const cap = Number(state.capital_day_915 ?? 0);
      const pct = Number(state.max_loss_pct ?? 0);
      if (cap && pct) maxLossAbs = Math.round(cap * pct / 100);
    }

    const trailStep = Number(state.trail_step_profit ?? 0);
    const currentFloor = Number(state.active_loss_floor ?? -maxLossAbs);
    const currentPeak = Number(state.peak_profit ?? 0);

    const nextPeak = totalPnl > currentPeak ? totalPnl : currentPeak;

    let trailLevel = 0;
    if (trailStep > 0 && nextPeak > 0) {
      trailLevel = Math.floor(nextPeak / trailStep) * trailStep;
    }

    let newFloorCandidate = -maxLossAbs;
    if (trailLevel > 0) newFloorCandidate = trailLevel - maxLossAbs;

    const nextFloor = Math.max(newFloorCandidate, currentFloor);
    const remaining = totalPnl - nextFloor;

    await setState({
      peak_profit: nextPeak,
      active_loss_floor: nextFloor,
      remaining_to_max_loss: remaining
    });

    if (maxLossAbs > 0 && remaining <= 0) {
      await setState({
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_loss_floor_live_mtm",
        last_enforced_at: Date.now()
      });

      try {
        const cancelled = await cancelPending(kc);
        const squared = await squareOffAll(kc);
        await setState({ admin_last_enforce_result: { cancelled, squared, at: Date.now() } });
 } catch (e) {
        console.error("Auto enforce failed:", e);
      }
    }

    /* ------------------------------ RESPONSE ------------------------------ */
    return res.status(200).json({
      ok: true,
      processed: newTrades.length,
      newest_ts: newest
    });

  } catch (err) {
    console.error("enforce-trades error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
