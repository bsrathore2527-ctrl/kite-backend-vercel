// api/enforce-trades.js
// Processes new trades, updates cooldown/tripping/peak profit/floor logic.
// NO realised/unrealised writes to risk:today. MTM comes ONLY from positions-mtm.js.

import { kv, getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------- TIMESTAMP NORMALIZATION ------------------------- */
function normalizeTs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return (String(ts).length === 10 ? ts * 1000 : ts);
  }
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return (String(n).length === 10 ? n * 1000 : n);
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return Date.parse(s.replace(" ", "T") + "Z");
  }
  const p = Date.parse(s);
  return Number.isNaN(p) ? null : p;
}

/* ------------------- BOOK (FIFO) STORAGE KEYS ------------------- */
const LAST_TRADE_KEY = "guardian:last_trade_ts";
const BOOK_PREFIX = "guardian:book:";
const TRADEBOOK_KEY = "guardian:tradebook";

/* --------------------------- BASIC HELPERS --------------------------- */
async function getLastProcessedTs() {
  return Number(await kv.get(LAST_TRADE_KEY) || 0);
}
async function setLastProcessedTs(ts) {
  await kv.set(LAST_TRADE_KEY, Number(ts));
}
async function getBook(symbol) {
  return (await kv.get(BOOK_PREFIX + symbol)) || { instrument: symbol, lots: [], net_qty: 0 };
}
async function setBook(symbol, book) {
  await kv.set(BOOK_PREFIX + symbol, book);
}

/* ------------------------------ TRADEBOOK ------------------------------ */
async function appendToTradebook(t) {
  const raw = await kv.get(TRADEBOOK_KEY);
  const arr = Array.isArray(raw) ? raw : [];

  const ms = normalizeTs(t._ts || t.timestamp || Date.now()) || Date.now();

  const rec = {
    ts: ms,
    iso_date: new Date(ms).toISOString(),
    tradingsymbol: t.tradingsymbol || t.trading_symbol || t.instrument || t.symbol,
    account_id: t.account_id || null,
    trade_id: t.trade_id || t.order_id || null,
    side: (t.transaction_type || t.order_side || t.side || "").toUpperCase(),
    qty: Math.abs(Number(t.quantity || t.qty || 0)),
    price: Number(t.price || t.trade_price || t.avg_price || 0),
    raw: t,
    _ts: ms
  };

  arr.unshift(rec);
  if (arr.length > 200) arr.length = 200;
  await kv.set(TRADEBOOK_KEY, arr);
  return true;
}

/* ---------------------------- FIFO MATCHING ---------------------------- */
function matchSell(book, qty, price, tradeId, ts) {
  let qtyToMatch = qty;
  const realizedEvents = [];
  const newLots = [];

  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }

    if (lot.side === "BUY") {
      const avail = Math.abs(lot.qty);
      const take = Math.min(avail, qtyToMatch);
      const pnl = (price - lot.avg_price) * take;

      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: pnl,
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });

      lot.qty -= take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);

    } else {
      newLots.push(lot);
    }
  }

  if (qtyToMatch > 0) {
    newLots.push({ qty: -qtyToMatch, avg_price: price, side: "SELL", open_ts: ts });
  }

  const netQty = newLots.reduce((s, l) =>
    s + (l.side === "BUY" ? l.qty : -Math.abs(l.qty)), 0);

  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

function matchBuy(book, qty, price, tradeId, ts) {
  let qtyToMatch = qty;
  const realizedEvents = [];
  const newLots = [];

  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }

    if (lot.side === "SELL") {
      const avail = Math.abs(lot.qty);
      const take = Math.min(avail, qtyToMatch);
      const pnl = (lot.avg_price - price) * take;

      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: pnl,
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });

      lot.qty += take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);

    } else {
      newLots.push(lot);
    }
  }

  if (qtyToMatch > 0) {
    newLots.push({ qty, avg_price: price, side: "BUY", open_ts: ts });
  }

  const netQty = newLots.reduce((s, l) =>
    s + (l.side === "BUY" ? l.qty : -Math.abs(l.qty)), 0);

  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

/* ---------------------- CANCEL / SQUARE-OFF HELPERS ---------------------- */
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
      } catch { }
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
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
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
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();

    // Fetch trades
    const trades = (await kc.getTrades()) || [];

    // Update kite health
    await setState({
      kite_status: "ok",
      kite_last_ok_at: Date.now(),
      kite_error_message: null
    });

    const lastTs = await getLastProcessedTs();

    // Normalize + filter new trades
    const normalized = trades.map(t => ({
      ...t,
      _ts: normalizeTs(t.timestamp || t.trade_time || t.exchange_timestamp) || Date.now()
    })).sort((a, b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);
    let newest = lastTs;

    /* ------------------------- PROCESS NEW TRADES ------------------------- */
    for (const t of newTrades) {
      newest = Math.max(newest, t._ts);

      await appendToTradebook(t);

      const sym = t.tradingsymbol || t.trading_symbol || t.symbol;
      const tradeId = t.trade_id || t.order_id || `${sym}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || 0));
      const price = Number(t.price || t.avg_price || 0);
      const side = (t.transaction_type || t.side || "").toUpperCase();

      let book = await getBook(sym);

      const result = (
        side === "SELL"
          ? matchSell(book, qty, price, tradeId, t._ts)
          : matchBuy(book, qty, price, tradeId, t._ts)
      );

      await setBook(sym, result.updatedBook);

      /* ------ STORE REALIZED EVENTS (BUT DO NOT MODIFY risk:today) ------ */
      for (const ev of result.realizedEvents) {
        // Do not aggregate realised into risk:today — by requirement.
        await kv.set("guardian:realized:" + ev.trade_ids.join("_") + "_" + ev.close_ts, ev);
      }
    }

    if (newest > lastTs) await setLastProcessedTs(newest);

    /* --------------------------- LOSS-FLOOR CHECK --------------------------- */

    // Load MTM from KV (written by positions-mtm.js)
    const mtmObj = await kv.get("live:mtm") || {};
    let liveMTM = Number(mtmObj.total ?? 0);

    // TEST override
    if (req.query && typeof req.query.test_mtm !== "undefined") {
      const v = Number(req.query.test_mtm);
      if (!isNaN(v)) liveMTM = v;
    }

    const state = await getState();
    const totalPnl = liveMTM;

    // Load config
    let maxLossAbs = Number(state.max_loss_abs ?? 0);
    if (!maxLossAbs) {
      const cap = Number(state.capital_day_915 ?? 0);
      const pct = Number(state.max_loss_pct ?? 0);
      if (cap > 0 && pct > 0) maxLossAbs = Math.round(cap * pct / 100);
    }

    const trailStep = Number(state.trail_step_profit ?? 0);

    const currentFloor = Number(state.active_loss_floor ?? -maxLossAbs);
    const currentPeak = Number(state.peak_profit ?? 0);

    // Update peak
    const nextPeak = totalPnl > currentPeak ? totalPnl : currentPeak;

    // Compute trail level
    let trailLevel = 0;
    if (trailStep > 0 && nextPeak > 0) {
      trailLevel = Math.floor(nextPeak / trailStep) * trailStep;
    }

    // Compute new floor candidate
    let newFloorCandidate = -maxLossAbs;
    if (trailLevel > 0) newFloorCandidate = trailLevel - maxLossAbs;

    const nextFloor = newFloorCandidate > currentFloor ? newFloorCandidate : currentFloor;
    const remaining = totalPnl - nextFloor;

    // Update floor & peak
    await setState({
      peak_profit: nextPeak,
      active_loss_floor: nextFloor,
      remaining_to_max_loss: remaining
    });

    // Trip logic
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
