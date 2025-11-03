// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, update tradebook,
// sync realised/unrealised totals from Kite funds/positions, start cooldown and track consecutive losses.
// Also: when total (realised + unrealised) loss breaches max_loss_pct of capital_day_915,
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

// append to server tradebook (most recent first), keep only trades for today (UTC date) and limit to N
async function appendToTradebook(entry, limit = 50) {
  const raw = await kv.get(TRADEBOOK_KEY) || [];
  const arr = Array.isArray(raw) ? raw : [];
  // add new entry at front
  arr.unshift(entry);
  // keep only today entries (by iso_date) -- compute today's UTC date string
  const todayIso = new Date().toISOString().slice(0,10);
  const filtered = arr.filter(it => (it.iso_date === todayIso));
  // limit length
  const limited = filtered.slice(0, limit);
  await kv.set(TRADEBOOK_KEY, limited);
  return limited;
}

// FIFO matching (BUY/SELL matching) helpers
function matchSellAgainstBook(book, sellQty, sellPrice, tradeId, ts) {
  let qtyToMatch = sellQty;
  const realizedEvents = [];
  const newLots = [];
  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }
    if (lot.side === "BUY") {
      const available = Math.abs(Number(lot.qty || 0));
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
      lot.qty = Number(lot.qty) - take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else {
      newLots.push(lot);
    }
  }
  if (qtyToMatch > 0) {
    // remaining becomes new SELL lot
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
      const available = Math.abs(Number(lot.qty || 0));
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
      lot.qty = Number(lot.qty) + take;
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

/* --------- Kite helpers: cancel / square off ---------- */
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
      } catch (e) { /* ignore individual failures */ }
    }
    return cancelled;
  } catch (e) { return 0; }
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
      } catch (e) { /* ignore per-symbol failure */ }
    }
    return squared;
  } catch (e) { return 0; }
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

    const normalized = (Array.isArray(trades) ? trades : []).map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: tts };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;
    let anyTradebookAdds = 0;
    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);
      const sym = t.tradingsymbol || t.trading_symbol || t.instrument_token || t.instrument;
      const tradeId = t.trade_id || `${t.order_id || t.orderId}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || t.filled_quantity || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || t.fill_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || t.type || "").toUpperCase() || (t.buySell || "").toUpperCase();

      // append to server tradebook (store only basic info + raw)
      const entry = {
        ts: t._ts,
        iso_date: new Date(t._ts).toISOString().slice(0,10),
        tradingsymbol: sym || null,
        side: side || null,
        qty,
        price: price || null,
        raw: t
      };
      await appendToTradebook(entry, 50);
      anyTradebookAdds++;

      // update per-instrument book and compute realized events
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

    // Sync realised/unrealised totals from Kite (prefer funds m2m fields)
    try {
      const stateBefore = await getState();
      let realised = Number(stateBefore.realised ?? 0);
      let unreal = Number(stateBefore.unrealised ?? 0);

      try {
        const funds = await kc.getFunds?.();
        if (funds) {
          // try equity.utilised.m2m_realised and m2m_unrealised
          const equity = funds.equity || funds;
          const utilised = equity.utilised || equity.utilization || {};
          const m2m_realised = Number(utilised.m2m_realised ?? equity.m2m_realised ?? 0);
          const m2m_unrealised = Number(utilised.m2m_unrealised ?? equity.m2m_unrealised ?? 0);
          if (!Number.isNaN(m2m_realised)) realised = m2m_realised;
          if (!Number.isNaN(m2m_unrealised)) unreal = m2m_unrealised;
        } else {
          // fallback: compute unreal from positions
          const pos = await kc.getPositions?.();
          if (pos) {
            const net = pos.net || [];
            let computedUnreal = 0;
            for (const p of net) {
              const v = Number(p.pnl?.unrealised ?? p.unrealised_pnl ?? p.m2m_unrealised ?? p.pnl_unrealised ?? 0);
              computedUnreal += Number.isFinite(v) ? v : 0;
            }
            unreal = computedUnreal;
          }
        }
      } catch (e) {
        // kite funds/positions fetch failed -> retain persisted values
        console.warn("enforce-trades: kite funds/positions fetch failed:", e && e.message ? e.message : e);
      }

      const total = Number(realised + unreal);
      await setState({ realised: Number(realised), unrealised: Number(unreal), total_pnl: Number(total) });
    } catch (e) {
      console.warn("enforce-trades: sync realised/unreal failed:", e && e.message ? e.message : e);
    }

    // --- NEW: check overall loss floor (realised + unrealised) and auto-enforce if breached ---
    try {
      const state = await getState();
      const realised = Number(state.realised ?? 0);
      const unreal = Number(state.unrealised ?? 0);
      const total = realised + unreal; // net profit (can be negative)

      const capital = Number(state.capital_day_915 || 0);
      const maxLossPct = Number(state.max_loss_pct ?? 0);
      const maxLossAbs = Math.round(capital * (maxLossPct / 100)); // e.g. 10000
      const lossThreshold = -Math.abs(maxLossAbs); // e.g. -10000

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
      console.warn("enforce-trades loss-floor check failed:", e && e.message ? e.message : e);
    }

    return res.status(200).json({ ok: true, processed, newest_ts: newest, tradebook_added: anyTradebookAdds });
  } catch (err) {
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
        }
