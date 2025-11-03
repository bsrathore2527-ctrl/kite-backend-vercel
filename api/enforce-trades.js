// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, start cooldown and track consecutive losses.
// Also: when total (realised + unrealised) loss breaches max_loss_abs derived from capital & max_loss_pct,
// mark tripped_day and immediately attempt to enforce (cancel + square off).

import { kv, getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:"; // store realized events idempotently
const BOOK_PREFIX = "guardian:book:";          // per-instrument book
const TRADEBOOK_KEY = "guardian:tradebook";

function now() { return Date.now(); }

function makeRealizedId(tradeIds = [], ts = 0) {
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

// append trade into server-side tradebook (keeps latest first)
async function appendToTradebook(t) {
  try {
    const raw = await kv.get(TRADEBOOK_KEY);
    const arr = Array.isArray(raw) ? raw : [];
    // normalize minimal display fields
    const rec = {
      ts: t._ts || Date.now(),
      iso_date: (typeof t._ts === "number") ? new Date(t._ts).toISOString() : t.iso_date || null,
      tradingsymbol: t.tradingsymbol || t.trading_symbol || t.instrument || t.symbol,
      account_id: t.account_id || t.accountId || null,
      trade_id: t.trade_id || t.tradeId || (t.order_id ? `${t.order_id}` : null),
      side: (t.transaction_type || t.order_side || t.side || "").toUpperCase(),
      qty: Math.abs(Number(t.quantity || t.qty || 0)),
      price: Number(t.price || t.trade_price || t.avg_price || 0),
      raw: t.raw || t
    };
    // unshift into array (most recent first) and limit to 200 (store more if you want)
    arr.unshift(rec);
    if (arr.length > 200) arr.length = 200;
    await kv.set(TRADEBOOK_KEY, arr);
    return true;
  } catch (e) {
    return false;
  }
}

// FIFO matching functions (unchanged behavior)
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
      lot.qty = lot.qty - take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
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
      const pnl = (lot.avg_price - buyPrice) * take;
      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: Number(pnl),
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });
      lot.qty = lot.qty + take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
    newLots.push({ qty: qtyToMatch, avg_price: buyPrice, side: "BUY", open_ts: ts });
  }
  const netQty = newLots.reduce((s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))), 0);
  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

/* ---------------------------
   Helpers to cancel/square-off
   --------------------------- */
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
        await kc.cancelOrder(o.variety || "regular", o.order_id || o.orderId);
        cancelled++;
      } catch (e) {
        // ignore individual failures
      }
    }
    return cancelled;
  } catch (e) {
    return 0;
  }
}

async function squareOffAll(kc) {
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let squared = 0;
    for (const p of net) {
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      if (!qty) continue;
      const side = qty > 0 ? "SELL" : "BUY";
      const absQty = Math.abs(qty);
      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol,
          transaction_type: side,
          quantity: absQty,
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch (e) {
        // ignore per-symbol failure
      }
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

/* ---------------------------
   Main handler
   --------------------------- */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance(); // may throw if not logged in

    // fetch trades from kite (fall back to empty)
    const trades = (await kc.getTrades()) || [];

    // last processed timestamp (to avoid reprocessing)
    const lastTs = await getLastProcessedTs();

    // normalize timestamps into numeric _ts
    const normalized = trades.map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || t.order_timestamp || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: Number(tts || Date.now()) };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;
    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);

      // append to server-side tradebook for UI
      try { await appendToTradebook(t); } catch(e){ /* ignore */ }

      const sym = t.tradingsymbol || t.trading_symbol || t.instrument_token || t.instrument || t.symbol;
      const tradeId = t.trade_id || t.tradeId || `${t.order_id || t.orderId || ""}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || "").toUpperCase();

      let book = await getBook(sym);
      let result;
      if (side === "SELL") {
        result = matchSellAgainstBook(book, qty, price, tradeId, t._ts);
      } else {
        result = matchBuyAgainstBook(book, qty, price, tradeId, t._ts);
      }

      await setBook(sym, result.updatedBook);

      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue;

        // update global state: cooldown, consecutive_losses, last trade PnL/time
        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = Date.now();
        const cooldownUntil = nowTs + cooldownMin * 60 * 1000;
        const isLoss = Number(ev.realized_pnl) < 0;

        // respect min_loss_to_count if present
        const minLossToCount = Number(s.min_loss_to_count ?? 0);
        const countsAsLoss = isLoss && (Math.abs(Number(ev.realized_pnl)) >= minLossToCount);

        const nextConsec = countsAsLoss ? ((s.consecutive_losses || 0) + 1) : (isLoss ? (s.consecutive_losses || 0) + 1 : 0);

        const patch = {
          last_trade_pnl: Number(ev.realized_pnl),
          last_trade_time: ev.close_ts,
          cooldown_until: cooldownUntil,
          cooldown_active: true,
          consecutive_losses: nextConsec
        };

        // consecutive loss limit check
        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        if (maxConsec > 0 && nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
        }

        await setState(patch);
      }
    }

    if (newest > lastTs) {
      await setLastProcessedTs(newest);
    }

    // --- LOSS-FLOOR CHECK ---
    // load fresh state and compute totals
    try {
      const state = await getState();
      const realised = Number(state.realised ?? 0);
      const unreal = Number(state.unrealised ?? 0);
      const total = realised + unreal;

      // derive max_loss_abs: prefer stored value else compute from capital_day_915 * max_loss_pct
      let maxLossAbs = Number(state.max_loss_abs ?? 0);
      if (!maxLossAbs || maxLossAbs === 0) {
        const capital = Number(state.capital_day_915 ?? 0);
        const pct = Number(state.max_loss_pct ?? 0);
        if (capital > 0 && pct > 0) {
          maxLossAbs = Math.round(capital * (pct / 100));
        }
      }

      // compute remaining-to-floor (for double-check). If state has remaining_to_max_loss, prefer that.
      const remaining = (typeof state.remaining_to_max_loss === "number") ? Number(state.remaining_to_max_loss) : Math.round(maxLossAbs + total);

      // Decide whether to trip:
      // Trip if: maxLossAbs > 0 AND (total <= -maxLossAbs OR remaining <= 0)
      if (maxLossAbs > 0 && (total <= -maxLossAbs || remaining <= 0)) {
        // mark tripped and block new orders
        const tripPatch = {
          tripped_day: true,
          block_new_orders: true,
          trip_reason: "max_loss_floor",
          last_enforced_at: Date.now()
        };
        await setState(tripPatch);

        // attempt immediate enforcement
        try {
          const cancelled = await cancelPending(kc);
          const squared = await squareOffAll(kc);
          const notePatch = { admin_last_enforce_result: { cancelled, squared, at: Date.now() } };
          await setState(notePatch);
          console.log("Auto-enforce executed:", notePatch.admin_last_enforce_result);
        } catch (e) {
          console.error("Auto-enforce failed:", e && e.stack ? e.stack : e);
        }
      }
    } catch (e) {
      console.warn("loss-floor check failed:", e && e.message ? e.message : e);
    }

    return res.status(200).json({ ok: true, processed, newest_ts: newest });
  } catch (err) {
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
                                                }
