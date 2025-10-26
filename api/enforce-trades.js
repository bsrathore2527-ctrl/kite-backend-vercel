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

export default async function handler(req, res) {
  // Accept GET/POST/OPTIONS for scheduler compatibility
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const kc = await instance(); // may throw if not logged in
    const trades = (await kc.getTrades()) || [];
    const lastTs = await getLastProcessedTs();

    // normalize timestamp field
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

      let book = await getBook(sym);

      let result;
      if (side === "SELL") {
        result = matchSellAgainstBook(book, qty, price, tradeId, t._ts);
      } else {
        result = matchBuyAgainstBook(book, qty, price, tradeId, t._ts);
      }

      await setBook(sym, result.updatedBook);

      // process realized events
      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue; // skip duplicates

        // load global state
        const s = await getState();

        // parameters from state (with sensible defaults)
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        const nowTs = Date.now();

        // configurable threshold to ignore tiny losses (optional)
        const minLossToCount = Number(s.min_loss_to_count ?? 0);
        const realizedPnl = Number(ev.realized_pnl || 0);
        const isLoss = (realizedPnl < 0) && (Math.abs(realizedPnl) >= minLossToCount);

        // compute consecutive losses: increment on loss, reset to 0 on profit/zero
        const prevConsec = Number(s.consecutive_losses || 0);
        const nextConsec = isLoss ? (prevConsec + 1) : 0;

        // Build patch object
        const patch = {
          last_trade_pnl: realizedPnl,
          last_trade_time: ev.close_ts,
          consecutive_losses: nextConsec
        };

        // Apply cooldown if it's a loss OR if admin enabled cooldown_on_profit
        const cooldownOnProfit = !!s.cooldown_on_profit;
        if (isLoss || cooldownOnProfit) {
          patch.cooldown_until = nowTs + cooldownMin * 60 * 1000;
          patch.cooldown_active = true;
        } else {
          // clear active flag if no cooldown applicable (but preserve cooldown_until if you wish)
          patch.cooldown_active = false;
        }

        // if consecutive losses exceed limit -> trip day & block new orders
        if (nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
          patch.streak_tripped_at = nowTs;
          patch.streak_tripped_count = nextConsec;
          console.log(`streak trip: consecutive_losses ${nextConsec} >= limit ${maxConsec}`);
        }

        // persist
        await setState(patch);

        // audit log
        console.log(`[guardian] realized ${ev.instrument} qty=${ev.qty} pnl=${realizedPnl} isLoss=${isLoss} prevConsec=${prevConsec} nextConsec=${nextConsec} cooldownOnProfit=${cooldownOnProfit}`);
      }
    }

    // update last processed pointer
    if (newest > lastTs) {
      await setLastProcessedTs(newest);
    }

    return res.status(200).json({ ok: true, processed, newest_ts: newest });
  } catch (err) {
    console.error("enforce-trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
