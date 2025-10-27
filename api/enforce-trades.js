// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, start cooldown and track consecutive losses.
// Place in your repo at api/enforce-trades.js and schedule it via QStash (every 15-60s recommended).

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:"; // store realized events idempotently
const BOOK_PREFIX = "guardian:book:";          // per-instrument book

function now() { return Date.now(); }

function makeRealizedId(tradeIds = [], ts = 0) {
  // deterministic id to avoid duplicates
  const ids = Array.isArray(tradeIds) ? tradeIds.join("_") : String(tradeIds || "");
  return `r_${ids}_${ts}`;
}

async function getLastProcessedTs() {
  const v = await kv.get(LAST_TRADE_KEY);
  return Number(v || 0);
}
async function setLastProcessedTs(ts) {
  await kv.set(LAST_TRADE_KEY, Number(ts));
}

async function getBook(sym) {
  const b = (await kv.get(BOOK_PREFIX + sym)) || { instrument: sym, lots: [], net_qty: 0 };
  return b;
}
async function setBook(sym, book) {
  await kv.set(BOOK_PREFIX + sym, book);
}

async function storeRealizedEvent(evt) {
  const id = makeRealizedId(evt.trade_ids || [], evt.close_ts || now());
  const key = REALIZED_PREFIX + id;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.set(key, evt);
  return true;
}

// FIFO matching functions
function matchSellAgainstBook(book, sellQty, sellPrice, tradeId, ts) {
  let qtyToMatch = sellQty;
  const realizedEvents = [];
  const newLots = [];
  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }
    if (lot.side === "BUY") {
      const available = Math.abs(lot.qty);
      const take = Math.min(available, qtyToMatch);
      const pnl = (sellPrice - lot.avg_price) * take;
      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: Number(pnl),
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });
      // reduce lot
      lot.qty = lot.qty - take; // lot.qty positive
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      // keep same-side lots (SELL) as is
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
    // opening a short position for the remaining qty
    newLots.push({ qty: -qtyToMatch, avg_price: sellPrice, side: "SELL", open_ts: ts });
  }
  const netQty = newLots.reduce((s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))), 0);
  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

function matchBuyAgainstBook(book, buyQty, buyPrice, tradeId, ts) {
  let qtyToMatch = buyQty;
  const realizedEvents = [];
  const newLots = [];
  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }
    if (lot.side === "SELL") {
      const available = Math.abs(lot.qty);
      const take = Math.min(available, qtyToMatch);
      const pnl = (lot.avg_price - buyPrice) * take; // closing a short: profit if sold higher than buy back
      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: Number(pnl),
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });
      lot.qty = lot.qty + take; // lot.qty negative increases toward zero
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
    // opening new long lots
    newLots.push({ qty: qtyToMatch, avg_price: buyPrice, side: "BUY", open_ts: ts });
  }
  const netQty = newLots.reduce((s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))), 0);
  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

/* Helper: cancel pending orders on kite instance (best-effort) */
async function cancelPendingOnInstance(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s === "PUT" || s === "PENDING";
    });
    let cancelled = 0;
    for (const o of pending) {
      try {
        if (typeof kc.cancelOrder === "function") {
          await kc.cancelOrder(o.variety || "regular", o.order_id || o.orderId || o.id);
        } else if (typeof kc.cancel === "function") {
          await kc.cancel(o.order_id || o.orderId || o.id);
        }
        cancelled++;
      } catch (e) {
        // ignore
      }
    }
    return cancelled;
  } catch (e) { return 0; }
}

/* Helper: square off all net positions on kite instance (best-effort) */
async function squareOffAllOnInstance(kc) {
  try {
    const positions = await kc.getPositions();
    const net = positions?.net || positions?.data?.net || [];
    let squared = 0;
    for (const p of net) {
      const qty = Number(p.net_quantity ?? p.quantity ?? p.quantity_ ?? 0);
      if (!qty) continue;
      const side = qty > 0 ? "SELL" : "BUY";
      const absQty = Math.abs(qty);
      try {
        if (typeof kc.placeOrder === "function") {
          await kc.placeOrder("regular", {
            exchange: p.exchange || p.exch || "NSE",
            tradingsymbol: p.tradingsymbol || p.trading_symbol || p.tradingSymbol,
            transaction_type: side,
            quantity: absQty,
            order_type: "MARKET",
            product: p.product || "MIS",
            validity: "DAY"
          });
          squared++;
        }
      } catch (e) {
        // ignore per-symbol failure
      }
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

/* main handler */
export default async function handler(req, res) {
  // Accept GET/POST/OPTIONS for scheduler compatibility
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const kc = await instance(); // may throw if not logged in
    // fetch all trades from kite (today). Assumes kc.getTrades() exists.
    const trades = (await kc.getTrades()) || [];
    // normalize timestamp field: try t.timestamp or t.trade_time or t.order_timestamp
    const lastTs = await getLastProcessedTs();

    // sort ascending and filter only new trades
    const normalized = trades.map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: tts };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;
    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);
      const sym = t.tradingsymbol || t.trading_symbol || t.instrument_token || t.instrument;
      const tradeId = t.trade_id || `${t.order_id || t.orderId}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || "").toUpperCase();

      // load book
      let book = await getBook(sym);

      let result;
      if (side === "SELL") {
        result = matchSellAgainstBook(book, qty, price, tradeId, t._ts);
      } else {
        result = matchBuyAgainstBook(book, qty, price, tradeId, t._ts);
      }

      // save updated book
      await setBook(sym, result.updatedBook);

      // process realized events
      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue; // skip duplicates

        // ---- NEW/UPDATED LOGIC START ----
        // update global state: respect min_loss_to_count, reset on profit, update realised/unrealised, handle trip
        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = Date.now();

        // rule: only count a loss if abs(pnl) >= min_loss_to_count (default 0)
        const minLoss = Number(s.min_loss_to_count ?? 0);
        const pnl = Number(ev.realized_pnl || 0);
        const absPnl = Math.abs(pnl);
        const wasLoss = pnl < 0;
        const isLoss = wasLoss && (absPnl >= minLoss);

        // reset consecutive on profitable close, increment on qualifying loss
        let nextConsec = s.consecutive_losses || 0;
        if (pnl > 0) {
          nextConsec = 0;
        } else if (isLoss) {
          nextConsec = (s.consecutive_losses || 0) + 1;
        }

        // cooldown behavior: apply cooldown if it's a qualifying loss OR if admin enabled cooldown_on_profit
        const cooldownOnProfit = !!s.cooldown_on_profit;
        let cooldownUntil = 0;
        let cooldownActive = false;
        if (isLoss || cooldownOnProfit) {
          cooldownUntil = nowTs + cooldownMin * 60 * 1000;
          cooldownActive = true;
        }

        // update cumulative realised in state (merge)
        const prevReal = Number(s.realised || 0);
        const newReal = prevReal + pnl;

        // derive current unrealised (prefer fresh positions from Kite if available)
        let currentUnreal = Number(s.unrealised || 0);
        try {
          const kcUn = await instance();
          const positionsUn = await kcUn.getPositions();
          if (positionsUn && Array.isArray(positionsUn.net)) {
            let sumUn = 0;
            for (const p of positionsUn.net) {
              sumUn += Number(p.pnl ?? p.unrealised_pnl ?? p.mtM ?? 0) || 0;
            }
            currentUnreal = sumUn;
          }
        } catch (e) {
          // ignore; fallback to s.unrealised
        }

        // total PnL = realised (cumulative) + unrealised (open positions)
        const totalPnL = Number(newReal || 0) + Number(currentUnreal || 0);

        const patch = {
          last_trade_pnl: pnl,
          last_trade_time: ev.close_ts,
          cooldown_until: cooldownUntil,
          cooldown_active: !!cooldownActive,
          consecutive_losses: nextConsec,
          realised: newReal,
          unrealised: currentUnreal
        };

        // if consecutive losses exceed limit -> trip and block
        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        if (nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
        }

        // also check max loss floor (percentage) using realized + unrealised
        const capital = Number(s.capital_day_915 ?? 0);
        const pctLimit = Number(s.max_loss_pct ?? 10);
        const floorLimit = capital * (pctLimit / 100);

        if (totalPnL <= -Math.abs(floorLimit)) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_loss_pct";
        }

        // write back patch
        await setState(patch);

        // ---- if we've tripped, attempt a best-effort auto-enforce (cancel + square off) ----
        const finalState = await getState();
        if (finalState.tripped_day) {
          try {
            const kc3 = await instance();
            const cancelled = await cancelPendingOnInstance(kc3);
            const squared = await squareOffAllOnInstance(kc3);
            await setState({ admin_auto_cancelled: cancelled, admin_auto_squared: squared, admin_auto_enforced_at: Date.now() });
          } catch (e) {
            // ignore failures — don't crash the worker
          }
        }
        // ---- NEW/UPDATED LOGIC END ----
      }
    }

    // update last processed pointer
    if (newest > lastTs) {
      await setLastProcessedTs(newest);
    }

    // return summary
    return res.status(200).json({ ok: true, processed, newest_ts: newest });
  } catch (err) {
    // don't crash QStash; return error
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
                                                         }
