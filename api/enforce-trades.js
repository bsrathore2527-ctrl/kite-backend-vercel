// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, start cooldown and track consecutive losses.
// Also: when total (realised + unrealised) loss breaches max_loss_pct of capital_day_915,
// mark tripped_day and immediately attempt to enforce (cancel + square off).

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:";
const BOOK_PREFIX = "guardian:book:";

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

// --- FIFO matching ---
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
      lot.qty -= take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else newLots.push(lot);
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
      lot.qty += take;
      qtyToMatch -= take;
      if (Math.abs(lot.qty) > 0) newLots.push(lot);
    } else newLots.push(lot);
  }
  if (qtyToMatch > 0) {
    newLots.push({ qty: buyQty, avg_price: buyPrice, side: "BUY", open_ts: ts });
  }
  const netQty = newLots.reduce((s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))), 0);
  return { realizedEvents, updatedBook: { instrument: book.instrument, lots: newLots, net_qty: netQty } };
}

// --- Cancel & square-off helpers ---
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s === "PENDING";
    });
    let cancelled = 0;
    for (const o of pending) {
      try { await kc.cancelOrder(o.variety || "regular", o.order_id); cancelled++; } catch {}
    }
    return cancelled;
  } catch { return 0; }
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
      } catch {}
    }
    return squared;
  } catch { return 0; }
}

// --- MAIN HANDLER ---
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  try {
    const kc = await instance();
    const trades = (await kc.getTrades()) || [];
    const lastTs = await getLastProcessedTs();

    const normalized = trades.map(t => {
      const ts = t.timestamp || t.trade_time || t.date || t.exchange_timestamp || t.utc_time || null;
      const tts = ts ? (typeof ts === "string" || typeof ts === "number" ? Number(ts) : Date.parse(ts)) : Date.now();
      return { ...t, _ts: tts };
    }).sort((a,b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    for (const t of newTrades) {
      newest = Math.max(newest, t._ts);
      const sym = t.tradingsymbol || t.trading_symbol || t.instrument_token || t.instrument;
      const tradeId = t.trade_id || `${t.order_id || t.orderId}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.trade_price || t.avg_price || 0);
      const side = (t.transaction_type || t.order_side || t.side || "").toUpperCase();
      let book = await getBook(sym);
      const result = side === "SELL"
        ? matchSellAgainstBook(book, qty, price, tradeId, t._ts)
        : matchBuyAgainstBook(book, qty, price, tradeId, t._ts);
      await setBook(sym, result.updatedBook);

      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue;
        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = Date.now();
        const cooldownUntil = nowTs + cooldownMin * 60 * 1000;
        const isLoss = Number(ev.realized_pnl) < 0;
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
        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        if (nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
        }
        await setState(patch);
      }
    }
    if (newest > lastTs) await setLastProcessedTs(newest);

    // --- persist raw trades into tradebook (today only) ---
    try {
      const TRADEBOOK_KEY = "guardian:tradebook";
      function dayKeyFromTs(ts) {
        try {
          const d = new Date(Number(ts));
          return d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }).split(",")[0]
            .split("/").reverse().join("-");
        } catch { return null; }
      }
      const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
      const todayKeyStr = `${nowIST.getFullYear()}-${String(nowIST.getMonth()+1).padStart(2,"0")}-${String(nowIST.getDate()).padStart(2,"0")}`;
      const existing = (await kv.get(TRADEBOOK_KEY)) || [];
      const map = new Map();
      for (const r of existing) {
        const ts = r.ts || r._stored_ts || r._ts;
        const dk = ts ? dayKeyFromTs(ts) : null;
        if (dk !== todayKeyStr) continue;
        const tid = r.trade_id || String(ts || "");
        if (tid) map.set(tid, r);
      }
      for (const t of normalized) {
        const ts = t._ts || Date.now();
        const dk = dayKeyFromTs(ts);
        if (dk !== todayKeyStr) continue;
        const tid = t.trade_id || (t.order_id ? String(t.order_id)+"_"+ts : String(ts));
        if (!tid || map.has(tid)) continue;
        map.set(tid, {
          trade_id: tid,
          account_id: t.account_id || t.account || null,
          tradingsymbol: t.tradingsymbol || t.trading_symbol || null,
          quantity: Number(t.quantity ?? t.qty ?? 0),
          price: Number(t.price ?? t.trade_price ?? t.avg_price ?? 0),
          side: (t.transaction_type || t.order_side || t.side || "").toUpperCase(),
          ts: Number(ts),
          raw: t,
          _stored_ts: Date.now()
        });
      }
      const arr = Array.from(map.values()).sort((a,b)=>(a.ts||0)-(b.ts||0));
      const keep = arr.slice(-500);
      await kv.set(TRADEBOOK_KEY, keep);
      console.log("tradebook saved (today only)", keep.length);
    } catch(e){ console.warn("tradebook save failed", e); }

    // --- check loss floor ---
    try {
      const s = await getState();
      const total = Number(s.realised ?? 0) + Number(s.unrealised ?? 0);
      const capital = Number(s.capital_day_915 || 0);
      const maxLossPct = Number(s.max_loss_pct ?? 10);
      const lossThreshold = -(capital * (maxLossPct/100));
      if (capital > 0 && total <= lossThreshold) {
        await setState({
          tripped_day: true, block_new_orders: true, trip_reason: "max_loss_floor", last_enforced_at: Date.now()
        });
        const cancelled = await cancelPending(kc);
        const squared = await squareOffAll(kc);
        await setState({ admin_last_enforce_result: { cancelled, squared, at: Date.now() } });
      }
    } catch(e){ console.warn("loss-floor check failed", e); }

    return res.status(200).json({ ok: true, processed: newTrades.length, newest_ts: newest });
  } catch (err) {
    console.error("enforce-trades error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
    }
