// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, start cooldown and track consecutive losses.
// Also: when total (realised + unrealised) loss breaches max_loss_pct of capital_day_915,
// mark tripped_day and immediately attempt to enforce (cancel + square off).
// Additionally: store recent trades into a server-side tradebook (KV) — only today's trades, capped.

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:";
const BOOK_PREFIX = "guardian:book:";          // per-instrument book (unchanged)
const TRADEBOOK_KEY = "guardian:tradebook";    // global tradebook (server)
const TRADEBOOK_MAX = 500;                     // keep most recent N trades

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

/* keep existing FIFO matching code (unchanged) */
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
   Helpers to cancel/square-off (kept inline)
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
      } catch (e) {}
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
      } catch (e) {}
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

/* ---------------------------
   Tradebook helpers
   --------------------------- */

// Return YYYY-MM-DD in Asia/Kolkata for given epoch/timestamp (ms)
function istDateString(ts = Date.now()) {
  const d = new Date(ts);
  // convert to UTC minutes +5:30 => shift by offset milliseconds
  const offset = 5.5 * 60; // minutes
  const localTs = ts + offset * 60 * 1000;
  const dd = new Date(localTs);
  const y = dd.getUTCFullYear();
  const m = String(dd.getUTCMonth() + 1).padStart(2, '0');
  const day = String(dd.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${day}`;
}

// Normalize trade object for persisted tradebook (keep only fields UI needs)
function normalizeTradeForBook(raw) {
  const ts = raw.timestamp || raw.trade_time || raw.date || raw.exchange_timestamp || raw.utc_time || raw._ts || Date.now();
  const tms = typeof ts === 'number' ? ts : (Date.parse(ts) || Date.now());
  const side = (raw.transaction_type || raw.order_side || raw.side || '').toUpperCase() || (raw.qty && Number(raw.qty) < 0 ? 'SELL' : 'BUY');

  return {
    ts: tms,
    iso_date: new Date(tms).toISOString(),
    tradingsymbol: raw.tradingsymbol || raw.trading_symbol || raw.instrument || raw.instrument_token || '—',
    order_id: raw.order_id || raw.orderId || null,
    trade_id: raw.trade_id || raw.tradeId || null,
    account_id: raw.account_id || raw.user_id || null,
    quantity: Number(raw.quantity || raw.qty || raw.filled_qty || 0),
    price: Number(raw.price || raw.trade_price || raw.avg_price || 0),
    side,
    raw: raw
  };
}

// read tradebook (array)
async function readTradebook() {
  try {
    const raw = await kv.get(TRADEBOOK_KEY);
    return Array.isArray(raw) ? raw : [];
  } catch (e) {
    return [];
  }
}

// write tradebook (array)
async function writeTradebook(arr) {
  try {
    await kv.set(TRADEBOOK_KEY, arr);
    return true;
  } catch (e) {
    return false;
  }
}

/* ---------------------------
   Main handler
   --------------------------- */
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const kc = await instance(); // may throw if not logged in
    const trades = (await kc.getTrades()) || [];
    const lastTs = await getLastProcessedTs();

    const normalized = trades.map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: tts };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;
    const tradesToSave = []; // collect for tradebook

    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);
      const sym = t.tradingsymbol || t.trading_symbol || t.instrument_token || t.instrument;
      const tradeId = t.trade_id || `${t.order_id || t.orderId}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || "").toUpperCase();

      // save raw trade into tradebook candidates (normalized)
      tradesToSave.push(normalizeTradeForBook({ ...t }));

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
        if (nextConsec >= maxConsec) {
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

    // persist tradesToSave into tradebook (server-side)
    try {
      if (tradesToSave.length > 0) {
        const existing = await readTradebook();
        // keep only today's trades: filter existing by IST date equals today
        const today = istDateString(Date.now());
        const filteredExisting = (existing || []).filter(t => {
          try { return istDateString(t.ts) === today; } catch (e) { return false; }
        });
        // merge existing (today) + new ones, dedupe by trade_id/order_id/ts
        const merged = [...filteredExisting, ...tradesToSave];
        // dedupe using trade_id + ts if available
        const seen = new Set();
        const deduped = [];
        for (let i = merged.length - 1; i >= 0; i--) { // iterate from newest to oldest preserving newest first
          const item = merged[i];
          const key = `${item.trade_id||''}:${item.order_id||''}:${item.ts||''}:${item.tradingsymbol||''}`;
          if (seen.has(key)) continue;
          seen.add(key);
          deduped.push(item);
          if (deduped.length >= TRADEBOOK_MAX) break;
        }
        // deduped currently newest-first, reverse to store oldest -> newest
        const finalArr = deduped.reverse();
        await writeTradebook(finalArr);
        console.log("enforce-trades | tradebook saved (today only)", finalArr.length);
      }
    } catch (e) {
      console.warn("tradebook save failed:", e && e.message ? e.message : e);
    }

    // --- NEW: check overall loss floor (realised + unrealised) and auto-enforce if breached ---
    try {
      const state = await getState();
      const realised = Number(state.realised ?? 0);
      const unreal = Number(state.unrealised ?? 0);
      const total = realised + unreal; // net profit (can be negative)

      const capital = Number(state.capital_day_915 || 0);
      const maxLossPct = Number(state.max_loss_pct ?? 10);
      const lossThreshold = -(capital * (maxLossPct / 100)); // e.g. -10000

      if (capital > 0 && total <= lossThreshold) {
        // trip and enforce
        const tripPatch = {
          tripped_day: true,
          block_new_orders: true,
          trip_reason: "max_loss_floor",
          last_enforced_at: Date.now()
        };
        await setState(tripPatch);

        // try immediate enforcement via kite (cancel + square off)
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
