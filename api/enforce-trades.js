// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, update tradebook,
// start cooldown and track consecutive losses, and auto-enforce on loss-floor breach.

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:"; // idempotent realized events
const BOOK_PREFIX = "guardian:book:";          // per-instrument book (lots)
const TRADEBOOK_KEY = "guardian:tradebook";    // server-side tradebook (array)

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

async function getTradebook() {
  const raw = await kv.get(TRADEBOOK_KEY);
  return Array.isArray(raw) ? raw : [];
}
async function setTradebook(arr) {
  await kv.set(TRADEBOOK_KEY, arr);
}

async function storeRealizedEvent(evt) {
  const id = makeRealizedId(evt.trade_ids || [], evt.close_ts || now());
  const key = REALIZED_PREFIX + id;
  const existing = await kv.get(key);
  if (existing) return false;
  await kv.set(key, evt);
  return true;
}

// FIFO matching (BUY/SELL) against book lots (basic algorithm)
function matchSellAgainstBook(book, sellQty, sellPrice, tradeId, ts) {
  let qtyToMatch = sellQty;
  const realizedEvents = [];
  const newLots = [];
  for (let lot of book.lots) {
    if (qtyToMatch <= 0) { newLots.push(lot); continue; }
    if (lot.side === "BUY") {
      const available = Math.abs(Number(lot.qty || 0));
      const take = Math.min(available, qtyToMatch);
      const pnl = (sellPrice - Number(lot.avg_price || 0)) * take;
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
    // remaining is a new SELL lot (open)
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
      const pnl = (Number(lot.avg_price || 0) - buyPrice) * take;
      realizedEvents.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: Number(pnl),
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });
      lot.qty = Number(lot.qty) + take; // SELL lot qty is negative; add back
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
      } catch (e) {
        // ignore per-order error
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
   Helper: add trade to server tradebook (most-recent-first)
   --------------------------- */
async function pushToTradebook(t) {
  try {
    const tb = await getTradebook();
    // normalize trade entry fields we want to persist
    const entry = {
      ts: Number(t._ts || t.ts || Date.now()),
      iso_date: new Date(Number(t._ts || t.ts || Date.now())).toISOString(),
      tradingsymbol: t.tradingsymbol || t.trading_symbol || t.instrument || t.symbol || "",
      side: (t.transaction_type || t.order_side || t.side || "").toUpperCase(),
      qty: Math.abs(Number(t.quantity || t.qty || t.quantity_ordered || 0)),
      price: (typeof t.price !== "undefined" && t.price !== null && t.price !== "") ? Number(t.price) :
             (typeof t.trade_price !== "undefined" ? Number(t.trade_price) : (typeof t.avg_price !== "undefined" ? Number(t.avg_price) : null)),
      trade_id: t.trade_id || (t.order_id ? `${t.order_id}_${t._ts || t.ts || Date.now()}` : undefined),
      raw: t
    };
    tb.unshift(entry);
    // limit size
    const MAX = 200;
    if (tb.length > MAX) tb.length = MAX;
    await setTradebook(tb);
  } catch (e) {
    console.warn("pushToTradebook failed:", e && e.message ? e.message : e);
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

    // normalize timestamps for sorting & processing
    const normalized = (trades || []).map(t => {
      // tolerant timestamp parsing
      const tsRaw = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || t.order_timestamp || t.order_time || null;
      let tts = null;
      if (tsRaw == null) {
        tts = Date.now();
      } else if (typeof tsRaw === "number") {
        tts = Number(tsRaw);
      } else {
        // string - try numeric or ISO parse
        const n = Number(tsRaw);
        tts = Number.isFinite(n) && n > 0 ? n : (Date.parse(tsRaw) || Date.now());
      }
      return { ...t, _ts: tts };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;

    // Process new trades: update book, realized events, and push to tradebook
    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts || Date.now());

      // write raw trade to server tradebook (recent-first)
      await pushToTradebook(t);

      const sym = t.tradingsymbol || t.trading_symbol || t.instrument || t.instrument_token || t.symbol || "unknown";
      const tradeId = t.trade_id || `${t.order_id || t.orderId || "oid"}_${t._ts || Date.now()}`;
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

      // handle realized events
      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue; // already processed

        // update global state: consecutive_losses, last_trade_pnl/time, cooldown etc.
        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = Date.now();
        const cooldownUntil = nowTs + cooldownMin * 60 * 1000;
        const isLoss = Number(ev.realized_pnl) < 0;

        // respect min_loss_to_count if present (only counts a loss if magnitude >= min_loss_to_count)
        const minLossToCount = Number(s.min_loss_to_count ?? 0);
        const countsAsLoss = isLoss && (Math.abs(Number(ev.realized_pnl)) >= minLossToCount);

        // next consecutive value: reset on profitable close
        const prevConsec = Number(s.consecutive_losses || 0);
        const nextConsec = countsAsLoss ? (prevConsec + 1) : (isLoss ? (prevConsec + 1) : 0);

        const patch = {
          last_trade_pnl: Number(ev.realized_pnl),
          last_trade_time: ev.close_ts || nowTs,
          cooldown_until: cooldownUntil,
          cooldown_active: true,
          consecutive_losses: nextConsec
        };

        // if consecutive threshold reached => trip day + block new orders
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

    // --- compute realised + unrealised totals and write to state ---
    try {
      const state = await getState();

      // Try to get funds from Kite (m2m_realised/m2m_unrealised). Fall back to positions for unrealised.
      let realisedTotal = Number(state.realised || 0);
      let unrealTotal = Number(state.unrealised || 0);

      try {
        const funds = await kc.getFunds?.() ?? null;
        // funds shape depends on kite lib; prefer funds.equity.utilised.m2m_realised etc.
        if (funds) {
          // attempt common paths
          const equity = funds.equity || funds;
          const utilised = equity.utilised || (equity.available && equity.available.utilised) || {};
          const m2m_realised = Number(utilised.m2m_realised ?? equity.m2m_realised ?? 0);
          const m2m_unrealised = Number(utilised.m2m_unrealised ?? equity.m2m_unrealised ?? 0);
          // Use m2m_realised for realized baseline if present (prefer server stored realized + m2m_realised)
          if (!Number.isNaN(m2m_realised)) realisedTotal = Number(m2m_realised);
          if (!Number.isNaN(m2m_unrealised)) unrealTotal = Number(m2m_unrealised);
        } else {
          // try positions fallback
          const pos = await kc.getPositions?.();
          const net = pos?.net || [];
          // compute unrealised as sum of p.net_m2m or p.m2m_unrealised depending on adapter
          let computedUnreal = 0;
          for (const p of net) {
            const pM2M = Number(p.pnl?.unrealised ?? p.pnl_unrealised ?? p.m2m_unrealised ?? p.m2m ?? 0);
            computedUnreal += Number.isFinite(pM2M) ? pM2M : 0;
          }
          unrealTotal = computedUnreal;
        }
      } catch (e) {
        // ignore kite funds fetch error — keep previous values
        console.warn("enforce-trades: getFunds/positions failed:", e && e.message ? e.message : e);
      }

      // sum any realized events stored in KV (optional: keep both)
      // Some workflows store realized in state; here we ensure state.realised reflects server KV sum if available
      const persistedRealised = Number(state.realised ?? 0);
      if (Math.abs(persistedRealised) !== Math.abs(realisedTotal)) {
        // prefer the greater (or kite value). This is conservative — you can change merge logic if needed.
        realisedTotal = realisedTotal || persistedRealised;
      }

      const total = Number(realisedTotal || 0) + Number(unrealTotal || 0);

      // Active loss floor & remaining to max loss
      const capital = Number(state.capital_day_915 || 0);
      const maxLossPct = Number(state.max_loss_pct ?? 10);
      const maxLossAmount = -Math.round(capital * (maxLossPct / 100)); // negative floor e.g. -10000
      const activeLossFloor = maxLossAmount; // currently only p10 floor; could be extended with p10_is_pct vs p10_amount

      // remaining to floor: if total is positive (profit), room before trip increases (floor - total),
      // since floor is negative, remaining = Math.abs(floor - total) but display logic in UI may assume positive value meaning "room".
      // We'll store numeric remaining = (Math.abs(activeLossFloor) - Math.abs(total)), but ensure sign semantics:
      let remainingToMaxLoss = (Math.abs(activeLossFloor) - Math.abs(total));
      // If total is negative beyond floor, remainingToMaxLoss will be negative/zero => trip already happened

      // Persist computed values into state
      const patch = {
        realised: Number(realisedTotal || 0),
        unrealised: Number(unrealTotal || 0),
        total_pnl: Number(total || 0),
        active_loss_floor: Number(activeLossFloor || 0),
        remaining_to_max_loss: Number(Math.round(remainingToMaxLoss) || 0)
      };
      await setState(patch);

      // If floor breached, auto trip and try enforce immediately
      if (capital > 0 && total <= activeLossFloor) {
        try {
          const tripPatch = {
            tripped_day: true,
            block_new_orders: true,
            trip_reason: "max_loss_floor",
            last_enforced_at: Date.now()
          };
          await setState(tripPatch);

          // do enforcement actions
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
      console.warn("enforce-trades: totals/floor update failed:", e && e.message ? e.message : e);
    }

    return res.status(200).json({ ok: true, processed, newest_ts: newest });
  } catch (err) {
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
    }
