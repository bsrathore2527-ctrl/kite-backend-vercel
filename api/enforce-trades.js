// api/enforce-trades.js
// Scheduled job — process new trades, compute realized closes, start cooldown, track consecutive losses
// and enforce max-loss using state.total_pnl (computed by mtm-worker).

import { kv, getState, setState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function normalizeTsToMs(ts) {
  if (ts == null) return null;
  if (typeof ts === "number" && Number.isFinite(ts)) {
    return (String(ts).length === 10) ? ts * 1000 : ts;
  }
  const s = String(ts).trim();
  if (/^\d+$/.test(s)) {
    const n = Number(s);
    return (String(n).length === 10) ? n * 1000 : n;
  }
  if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(s)) {
    return Date.parse(s.replace(" ", "T") + "Z");
  }
  const parsed = Date.parse(s);
  return Number.isNaN(parsed) ? null : parsed;
}

function now() { return Date.now(); }

const LAST_TRADE_KEY = "guardian:last_trade_ts";
const REALIZED_PREFIX = "guardian:realized:";
const BOOK_PREFIX = "guardian:book:";
const TRADEBOOK_KEY = "guardian:tradebook";

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

function makeRealizedId(ids = [], ts = 0) {
  const joined = Array.isArray(ids) ? ids.join("_") : String(ids || "");
  return `r_${joined}_${ts}`;
}

async function storeRealizedEvent(evt) {
  const id = makeRealizedId(evt.trade_ids || [], evt.close_ts || now());
  const key = REALIZED_PREFIX + id;
  const exists = await kv.get(key);
  if (exists) return false;
  await kv.set(key, evt);

  // Update aggregated realised in today's state
  try {
    const s = await getState();
    const current = Number(s.realised ?? 0);
    const add =
      Number(evt.realized_pnl ||
        evt.realised_pnl ||
        evt.realized ||
        evt.realised ||
        0);

    if (!Number.isNaN(add) && add !== 0) {
      await setState({ realised: current + add });
    }
  } catch { }

  return true;
}
/* ===========================================================
   🔥 NEW: Fetch & Save Current Positions for MTM worker
   =========================================================== */
try {
  const pos = await (kc.getPositions?.() || kc.get_positions?.());

  if (pos && pos.net) {
    await kv.set("guardian:positions", pos);

    console.log("📦 [enforce] Saved positions to KV:", {
      count: pos.net.length,
      tokens: pos.net.map(p => p.instrument_token)
    });
  } else {
    console.log("⚠ [enforce] Zerodha returned no positions");
  }
} catch (err) {
  console.log("❌ [enforce] Error fetching/saving positions:", err?.message || err);
}
async function appendToTradebook(t) {
  try {
    const raw = await kv.get(TRADEBOOK_KEY);
    let arr = Array.isArray(raw) ? raw : [];

    const norm = normalizeTsToMs(t._ts || t.timestamp || Date.now()) || Date.now();
    const rec = {
      ts: norm,
      iso_date: new Date(norm).toISOString(),
      tradingsymbol: t.tradingsymbol || t.trading_symbol || t.instrument || t.symbol,
      account_id: t.account_id || null,
      trade_id: t.trade_id || `${t.order_id || ""}_${norm}`,
      side: (t.transaction_type || t.side || "").toUpperCase(),
      qty: Math.abs(Number(t.quantity || t.qty || 0)),
      price: Number(t.price || t.avg_price || 0),
      raw: t.raw || t
    };

    arr.unshift(rec);
    if (arr.length > 200) arr.length = 200;

    await kv.set(TRADEBOOK_KEY, arr);
    return true;
  } catch {
    return false;
  }
}

// FIFO MATCHING: unchanged
function matchSellAgainstBook(book, sellQty, sellPrice, tradeId, ts) {
  let qtyRem = sellQty;
  const events = [];
  const lotsOut = [];

  for (let lot of book.lots) {
    if (qtyRem <= 0) { lotsOut.push(lot); continue; }
    if (lot.side === "BUY") {
      const available = Math.abs(lot.qty);
      const take = Math.min(available, qtyRem);
      const pnl = (sellPrice - lot.avg_price) * take;

      events.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: pnl,
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });

      lot.qty -= take;
      qtyRem -= take;

      if (Math.abs(lot.qty) > 0) lotsOut.push(lot);
    } else {
      lotsOut.push(lot);
    }
  }

  if (qtyRem > 0) {
    lotsOut.push({ qty: -qtyRem, avg_price: sellPrice, side: "SELL", open_ts: ts });
  }

  const netQty = lotsOut.reduce(
    (s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))),
    0
  );

  return { realizedEvents: events, updatedBook: { instrument: book.instrument, lots: lotsOut, net_qty: netQty } };
}

function matchBuyAgainstBook(book, buyQty, buyPrice, tradeId, ts) {
  let qtyRem = buyQty;
  const events = [];
  const lotsOut = [];

  for (let lot of book.lots) {
    if (qtyRem <= 0) { lotsOut.push(lot); continue; }
    if (lot.side === "SELL") {
      const available = Math.abs(lot.qty);
      const take = Math.min(available, qtyRem);
      const pnl = (lot.avg_price - buyPrice) * take;

      events.push({
        instrument: book.instrument,
        qty: take,
        realized_pnl: pnl,
        close_ts: ts,
        trade_ids: [tradeId],
        open_lot: { ...lot }
      });

      lot.qty += take;
      qtyRem -= take;

      if (Math.abs(lot.qty) > 0) lotsOut.push(lot);
    } else {
      lotsOut.push(lot);
    }
  }

  if (qtyRem > 0) {
    lotsOut.push({ qty: qtyRem, avg_price: buyPrice, side: "BUY", open_ts: ts });
  }

  const netQty = lotsOut.reduce(
    (s, l) => s + (l.side === "BUY" ? Number(l.qty || 0) : -Math.abs(Number(l.qty || 0))),
    0
  );

  return { realizedEvents: events, updatedBook: { instrument: book.instrument, lots: lotsOut, net_qty: netQty } };
}

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
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let squared = 0;

    for (const p of net) {
      const qty = Number(p.net_quantity);
      if (!qty) continue;

      const side = qty > 0 ? "SELL" : "BUY";

      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol,
          transaction_type: side,
          quantity: Math.abs(qty),
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch { }
    }

    return squared;
  } catch {
    return 0;
  }
}

// MAIN HANDLER
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  try {
    const kc = await instance();

    // fetch trades
    const trades = (await kc.getTrades()) || [];

    // health update
    await setState({
      kite_status: "ok",
      kite_last_ok_at: Date.now(),
      kite_error_message: null
    });

    const lastTs = await getLastProcessedTs();

    const normalized = trades.map(t => {
      const rawTs =
        t.timestamp || t.trade_time || t.date ||
        t.exchange_timestamp || t.utc_time ||
        t.order_timestamp || now();

      const ms = normalizeTsToMs(rawTs) || now();
      return { ...t, _ts: ms };
    }).sort((a, b) => a._ts - b._ts);

    const newTrades = normalized.filter(t => t._ts > lastTs);

    let newest = lastTs;
    let processed = 0;

    for (const t of newTrades) {
      processed++;
      newest = Math.max(newest, t._ts);

      await appendToTradebook(t).catch(() => { });

      const sym = t.tradingsymbol || t.trading_symbol || t.instrument || t.symbol;
      const tradeId = t.trade_id || `${t.order_id || ""}_${t._ts}`;
      const qty = Math.abs(Number(t.quantity || t.qty || 0));
      const price = Number(t.price || t.avg_price || 0);
      const side = (t.transaction_type || t.side || "").toUpperCase();

      let book = await getBook(sym);

      const result = (side === "SELL")
        ? matchSellAgainstBook(book, qty, price, tradeId, t._ts)
        : matchBuyAgainstBook(book, qty, price, tradeId, t._ts);

      await setBook(sym, result.updatedBook);

      for (const ev of result.realizedEvents) {
        const saved = await storeRealizedEvent(ev);
        if (!saved) continue;

        try {
          const s = await getState();
          const mtm = Number(s.total_pnl ?? 0);

          const rawSell = await kv.get("guardian:sell_orders");
          let arr = Array.isArray(rawSell)
            ? rawSell
            : (typeof rawSell === "string"
              ? (JSON.parse(rawSell) || [])
              : []);

          const last = arr.length ? arr[arr.length - 1] : null;
          const lastMtm = last ? Number(last.mtm) : 0;

          arr.push({
            instrument: ev.instrument,
            qty: ev.qty,
            mtm,
            mtm_change: mtm - lastMtm,
            time_ms: ev.close_ts
          });

          await kv.set("guardian:sell_orders", arr);
        } catch { }

        const s = await getState();
        const cooldownMin = Number(s.cooldown_min ?? 15);
        const nowTs = now();

        const isLoss = Number(ev.realized_pnl) < 0;
        const minLossToCount = Number(s.min_loss_to_count ?? 0);
        const countsAsLoss =
          isLoss && Math.abs(Number(ev.realized_pnl)) >= minLossToCount;

        const nextConsec = countsAsLoss
          ? (s.consecutive_losses || 0) + 1
          : (isLoss
            ? (s.consecutive_losses || 0) + 1
            : 0);

        const patch = {
          last_trade_pnl: Number(ev.realized_pnl),
          last_trade_time: ev.close_ts,
          cooldown_until: nowTs + cooldownMin * 60000,
          cooldown_active: true,
          consecutive_losses: nextConsec
        };

        const maxConsec = Number(s.max_consecutive_losses ?? 3);
        if (maxConsec > 0 && nextConsec >= maxConsec) {
          patch.tripped_day = true;
          patch.block_new_orders = true;
          patch.trip_reason = "max_consecutive_losses";
        }

        await setState(patch);
      }
    }

    if (newest > lastTs) await setLastProcessedTs(newest);

    /* --------------------------
       LOSS-FLOOR USING total_pnl
       -------------------------- */
    try {
      const s = await getState();
      let totalPnl = Number(s.total_pnl ?? 0);

      // TEST OVERRIDE
      if (req.query && typeof req.query.test_mtm !== "undefined") {
        const val = Number(req.query.test_mtm);
        if (!Number.isNaN(val)) totalPnl = val;
      }

      let maxLossAbs = Number(s.max_loss_abs ?? 0);
      if (!maxLossAbs) {
        const capital = Number(s.capital_day_915 ?? 0);
        const pct = Number(s.max_loss_pct ?? 0);
        if (capital > 0 && pct > 0) {
          maxLossAbs = Math.round(capital * pct / 100);
        }
      }

      const trailStep = Number(s.trail_step_profit ?? 0);

      const currentFloor = Number.isFinite(Number(s.active_loss_floor))
        ? Number(s.active_loss_floor)
        : (maxLossAbs ? -maxLossAbs : 0);

      const currentPeak = Number.isFinite(Number(s.peak_profit))
        ? Number(s.peak_profit)
        : 0;

      let nextPeak = currentPeak;
      if (totalPnl > currentPeak) nextPeak = totalPnl;

      let trailLevel = 0;
      if (trailStep && nextPeak > 0) {
        trailLevel = Math.floor(nextPeak / trailStep) * trailStep;
      }

      let newFloorCandidate = (trailLevel > 0 && maxLossAbs > 0)
        ? trailLevel - maxLossAbs
        : -maxLossAbs;

      let nextFloor = currentFloor;
      if (newFloorCandidate > nextFloor) nextFloor = newFloorCandidate;

      const remaining = totalPnl - nextFloor;

      await setState({
        peak_profit: nextPeak,
        max_loss_abs: maxLossAbs,
        active_loss_floor: nextFloor,
        remaining_to_max_loss: remaining
      });

      // trip condition
      if (maxLossAbs > 0 && remaining <= 0) {
        await setState({
          tripped_day: true,
          block_new_orders: true,
          trip_reason: "max_loss_floor_total_pnl",
          last_enforced_at: now()
        });

        try {
          const cancelled = await cancelPending(kc);
          const squared = await squareOffAll(kc);

          await setState({
            admin_last_enforce_result: {
              cancelled,
              squared,
              at: now()
            }
          });
        } catch { }
      }

    } catch (e) {
      console.error("LOSS-FLOOR total_pnl block failed:", e?.message || e);
    }

    return res.json({ ok: true, processed, newest_ts: newest });
  }

  catch (err) {
    console.error("enforce-trades ERROR:", err);
    await setState({
      kite_status: "error",
      kite_error_message: String(err)
    });
    return res.status(500).json({ ok: false, error: String(err) });
  }
        }
