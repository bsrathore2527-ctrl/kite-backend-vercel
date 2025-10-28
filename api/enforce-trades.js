// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, maintain tradebook,
// update realised/unrealised totals, track consecutive losses & cooldown,
// and auto-enforce (cancel + square-off) when total (realised + unrealised)
// breaches max_loss_pct of today's capital.
//
// Drop-in replacement for your existing file. Uses same kv keys and kite instance.

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:";   // per-realized event
const BOOK_PREFIX = "guardian:book:";           // per-instrument book
const TRADEBOOK_KEY = "guardian:tradebook";     // circular list of recent raw trades

const TRADEBOOK_MAX = 200;

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

// Append to tradebook (capped circular list)
async function appendTradebook(rawTrade) {
  try {
    const arr = (await kv.get(TRADEBOOK_KEY)) || [];
    arr.unshift(rawTrade);
    if (arr.length > TRADEBOOK_MAX) arr.length = TRADEBOOK_MAX;
    await kv.set(TRADEBOOK_KEY, arr);
  } catch (e) {
    // non-fatal
    console.warn("appendTradebook failed", e && e.message);
  }
}

// FIFO matching functions (unchanged logic)
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
      // same side (SELL) kept
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
    // opening short
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
   Helpers: cancel + square-off (copied inline)
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
        await kc.cancelOrder(o.variety || "regular", o.order_id);
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
    // kite instance (throws if not logged in)
    const kc = await instance();

    // fetch trades (today) from kite
    let trades = [];
    try {
      trades = (await kc.getTrades()) || [];
    } catch (e) {
      // if fetching trades fails, keep empty and return a helpful message below
      console.warn("kc.getTrades failed:", e && e.message);
    }

    // record raw trades in tradebook (for UI visibility)
    for (const rt of trades) {
      await appendTradebook({ ts: Date.now(), raw: rt });
    }

    const lastTs = await getLastProcessedTs();

    // normalize timestamp
    const normalized = trades.map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: tts };
    }).sort((a, b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;
    let realizedDeltaTotal = 0;

    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);
      const sym = t.tradingsymbol || t.trading_symbol || t.instrument || String(t.instrument_token || "");
      const tradeId = t.trade_id || `${t.order_id || t.orderId || "ord"}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || "").toUpperCase() || (t.qty && Number(t.qty) < 0 ? "SELL" : "BUY");

      // load book and match
      let book = await getBook(sym);
      let result;
      if (side === "SELL") {
        result = matchSellAgainstBook(book, qty, price, tradeId, t._ts);
      } else {
        result = matchBuyAgainstBook(book, qty, price, tradeId, t._ts);
      }

      // persist book
      await setBook(sym, result.updatedBook);

      // process realized events (update state)
      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue;

        realizedDeltaTotal += Number(ev.realized_pnl || 0);

        // update global state: cooldown, consecutive_losses, last trade PnL/time
        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = Date.now();
        const cooldownUntil = nowTs + cooldownMin * 60 * 1000;
        const isLoss = Number(ev.realized_pnl) < 0;

        // respect min_loss_to_count if present (>= threshold)
        const minLossToCount = Number(s.min_loss_to_count ?? 0);
        const countsAsLoss = isLoss && (Math.abs(Number(ev.realized_pnl)) >= minLossToCount);

        // Update consecutive losses: reset on profitable close, increment on qualifying loss
        let nextConsec = Number(s.consecutive_losses || 0);
        if (!isLoss) {
          nextConsec = 0;
        } else if (countsAsLoss) {
          nextConsec = nextConsec + 1;
        } else {
          // if it's a small loss below minLossToCount, don't count it
          nextConsec = nextConsec;
        }

        const patch = {
          last_trade_pnl: Number(ev.realized_pnl),
          last_trade_time: ev.close_ts,
          cooldown_until: cooldownUntil,
          cooldown_active: true,
          consecutive_losses: nextConsec
        };

        // consecutive loss threshold trip
        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        if (nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
        }

        await setState(patch);
      }
    }

    // update last processed pointer
    if (newest > lastTs) {
      await setLastProcessedTs(newest);
    }

    // update realised total in state by delta (so API/state shows cumulative realised)
    if (realizedDeltaTotal !== 0) {
      try {
        const s = await getState();
        const curReal = Number(s.realised || 0);
        await setState({ realised: Number(curReal + realizedDeltaTotal) });
      } catch (e) {
        console.warn("failed to persist realised delta:", e && e.message);
      }
    }

    // compute unrealised from kite positions (preferred) — fallback to existing s.unrealised
    let unrealisedSum = 0;
    try {
      const pos = await kc.getPositions();
      // prefer pos?.net which is an array of positions with pnl or unrealised fields
      const net = pos?.net || [];
      if (Array.isArray(net) && net.length) {
        // Many brokers expose fields like pnl, unrealised, m2m (use sensible fallbacks)
        unrealisedSum = net.reduce((acc, p) => {
          const pnl = Number(p.pnl ?? p.unrealised ?? p.unrealised_pnl ?? p.m2m ?? 0);
          return acc + (Number.isFinite(pnl) ? pnl : 0);
        }, 0);
      } else {
        // Attempt pos?.day or pos?.positions arrays if available
        const all = Array.isArray(pos) ? pos : (pos?.positions || []);
        if (Array.isArray(all) && all.length) {
          unrealisedSum = all.reduce((acc, p) => {
            const pnl = Number(p.pnl ?? p.unrealised ?? p.m2m ?? 0);
            return acc + (Number.isFinite(pnl) ? pnl : 0);
          }, 0);
        }
      }
    } catch (e) {
      console.warn("kc.getPositions failed:", e && e.message);
    }

    // write computed unrealised into state for UI to read (merge)
    try {
      await setState({ unrealised: Number(unrealisedSum) });
    } catch (e) {
      console.warn("persist unrealised failed:", e && e.message);
    }

    // --- LOSS FLOOR: check overall loss (realised + unrealised) and auto-enforce ---
    try {
      const state = await getState();
      const realised = Number(state.realised ?? 0);
      const unreal = Number(state.unrealised ?? 0);
      const total = realised + unreal; // net profit (negative if loss)

      const capital = Number(state.capital_day_915 || 0);
      const maxLossPct = Number(state.max_loss_pct ?? 10);
      const lossThreshold = -(capital * (maxLossPct / 100)); // e.g. -10000

      if (capital > 0 && total <= lossThreshold && !state.tripped_day) {
        // trip and enforce
        const tripPatch = {
          tripped_day: true,
          block_new_orders: true,
          trip_reason: "max_loss_floor",
          last_enforced_at: Date.now()
        };
        await setState(tripPatch);

        // attempt immediate enforcement (cancel + square off)
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

    return res.status(200).json({ ok: true, processed, newest_ts: newest, realised_delta: realizedDeltaTotal, unrealised: unrealisedSum });
  } catch (err) {
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
            }
