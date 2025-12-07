// api/risk-engine.js
// ------------------------------------------------------
// Unified engine that replaces:
// - mtm-worker.js MTM logic (copied, not reinvented)
// - enforce-trades.js risk + enforcement logic (rewritten per new spec)
// - guardian-ish connectivity status
//
// Uses:
//   - Redis via ./_lib/kv.js  (kv, getState, setState, todayKey)
//   - Zerodha via ./_lib/kite.js (instance)
//
// KEY DESIGN:
//   - Canonical live state via getState/setState (backwards compatible)
//   - Daily snapshot in kv under: risk:${todayKey()}
//   - LTP strictly from kv key "ltp:all"
//   - MTM FIFO logic directly copied from your mtm-worker.js
// ------------------------------------------------------

import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

/* ------------------------------------------------------
   FIFO ENGINE (copied from mtm-worker.js)
------------------------------------------------------ */

function fifoSell(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "BUY") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (price - lot.avg) * take;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    newLots.push({ side: "SELL", qty: qtyRem, avg: price });
  }

  return { realised, book: newLots };
}

function fifoBuy(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];

  for (const lot of book) {
    if (qtyRem <= 0) {
      newLots.push(lot);
      continue;
    }

    if (lot.side === "SELL") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (lot.avg - price) * take;

      if (lot.qty > take) {
        newLots.push({ ...lot, qty: lot.qty - take });
      }

      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }

  if (qtyRem > 0) {
    newLots.push({ side: "BUY", qty: qtyRem, avg: price });
  }

  return { realised, book: newLots };
}

/* ------------------------------------------------------
   REALISED PNL WITH OVERNIGHT PRELOAD (copied & adapted)
------------------------------------------------------ */

async function computeRealised(kc) {
  const trades = await kc.getTrades();

  // Sort trades chronologically
  trades.sort((a, b) => {
    const ta = new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp);
    const tb = new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp);
    return ta - tb;
  });

  const books = {};
  let realised = 0;

  // PRELOAD OVERNIGHT POSITIONS  (from mtm-worker)
  const pos = await kc.getPositions();
  const netPos = pos.net || [];

  for (const p of netPos) {
    const sym = p.tradingsymbol;
    const oq = Number(p.overnight_quantity || 0);

    if (!oq) continue;
    if (!books[sym]) books[sym] = [];

    const buyVal = Number(p.buy_value || 0);
    const dayBuyVal = Number(p.day_buy_value || 0);
    const overnightVal = buyVal - dayBuyVal;

    const overnightAvg = oq > 0 ? overnightVal / oq : 0;

    books[sym].push({
      side: "BUY",
      qty: oq,
      avg: overnightAvg,
    });
  }

  // PROCESS ALL TRADES USING FIFO
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const qty = Number(t.quantity);
    const side = (t.transaction_type || "").toUpperCase();
    const price = Number(t.average_price);

    if (!books[sym]) books[sym] = [];

    const result =
      side === "BUY"
        ? fifoBuy(books[sym], qty, price)
        : fifoSell(books[sym], qty, price);

    realised += result.realised;
    books[sym] = result.book;
  }

  return realised;
}

/* ------------------------------------------------------
   UNREALISED MTM + NET POSITIONS (adapted)
   - still uses kv("ltp:all")
------------------------------------------------------ */

async function computeUnrealisedAndNet(kc, ltpAll) {
  const pos = await kc.getPositions();
  const net = pos.net || [];

  let unrealised = 0;

  for (const p of net) {
    const qty = Number(p.quantity);
    if (!qty) continue;

    const avg = Number(p.average_price);
    const token = Number(p.instrument_token);

    const ltp = Number(ltpAll[token]?.last_price) || Number(p.last_price) || 0;

    const u = qty > 0
      ? (ltp - avg) * qty
      : (avg - ltp) * Math.abs(qty);

    unrealised += u;
  }

  return { unrealised, net };
}

/* ------------------------------------------------------
   ENFORCEMENT HELPERS (from enforce-trades/enforce)
------------------------------------------------------ */

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
      } catch {}
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
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      if (!qty) continue;

      const side = qty > 0 ? "SELL" : "BUY";

      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol,
          transaction_type: side,
          quantity: Math.abs(qty),
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch {}
    }

    return squared;
  } catch {
    return 0;
  }
}

// close ONLY newly added qty during cooldown
async function squareOffDelta(kc, sym, deltaQty) {
  try {
    const side = deltaQty > 0 ? "SELL" : "BUY";
    await kc.placeOrder("regular", {
      exchange: "NFO",           // same assumption as before
      tradingsymbol: sym,
      transaction_type: side,
      quantity: Math.abs(deltaQty),
      order_type: "MARKET",
      product: "MIS",
      validity: "DAY"
    });
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------
   MAIN HANDLER
------------------------------------------------------ */

function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // 1) Load current state (backwards-compatible)
    const s = (await getState()) || {};

    // 2) Daily snapshot key (same as set-config)
    const dayKey = `risk:${todayKey()}`;

    // 3) Connect to Kite
    let kc;
    try {
      kc = await instance();
    } catch (e) {
      const patch = {
        kite_status: "error",
        kite_error_message: String(e),
      };

      const next = await setState(patch);
      await kv.set(dayKey, next);

      return res.json({
        ok: false,
        error: "kite_connect_failed",
        kite_status: "error"
      });
    }

    // 4) If day already tripped → enforce directly
    if (s.tripped_day) {
      const cancelled = await cancelPending(kc);
      const squared = await squareOffAll(kc);

      const next = await setState({
        admin_last_enforce_result: {
          cancelled,
          squared,
          at: Date.now(),
          reason: "already_tripped_enforce"
        }
      });

      await kv.set(dayKey, next);

      return res.json({
        ok: true,
        enforced: true,
        reason: "already_tripped"
      });
    }

    // 5) LTP from KV
    const ltpAll = (await kv.get("ltp:all")) || {};

    // 6) MTM calc (mtm-worker logic)
    const realised = await computeRealised(kc);
    const { unrealised, net } = await computeUnrealisedAndNet(kc, ltpAll);
    const total = realised + unrealised;

    // 7) Risk logic (new model)
    const nowTs = Date.now();
    const minLossToCount = safeNum(s.min_loss_to_count || 0);
    const cooldownMin = safeNum(s.cooldown_min || 0);
    const maxConsec = safeNum(s.max_consecutive_losses || 0);

    const hist = Array.isArray(s.realised_history) ? [...s.realised_history] : [];
    const prevReal = hist.length ? safeNum(hist[hist.length - 1]) : safeNum(s.realised || 0);
    const delta = realised - prevReal;

    let patch = {
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: nowTs,
      kite_status: "ok",
      kite_error_message: null
    };

    let realisedHistory = hist;
    let consecutiveLosses = safeNum(s.consecutive_losses || 0);
    let cooldownActive = !!s.cooldown_active;
    let cooldownUntil = safeNum(s.cooldown_until || 0);
    let lastNetPositions = s.last_net_positions || {};
    let tripReason = s.trip_reason || null;
    let trippedDay = !!s.tripped_day;
    let blockNew = !!s.block_new_orders;

    // 7.a) Trade close detection (realised changed)
    if (delta !== 0) {
      realisedHistory.push(realised);
      if (realisedHistory.length > 200) realisedHistory = realisedHistory.slice(-200);

      // cooldown
      cooldownActive = true;
      cooldownUntil = nowTs + cooldownMin * 60000;

      // last trade time
      patch.last_trade_time = nowTs;

      // consecutive losses
      if (delta < 0 && Math.abs(delta) >= minLossToCount) {
        consecutiveLosses += 1;
      } else if (delta > 0) {
        consecutiveLosses = 0;
      }
    }

    patch.realised_history = realisedHistory;
    patch.cooldown_active = cooldownActive;
    patch.cooldown_until = cooldownUntil;
    patch.consecutive_losses = consecutiveLosses;

    // 7.b) Max consecutive loss trip
    if (maxConsec > 0 && consecutiveLosses >= maxConsec) {
      trippedDay = true;
      blockNew = true;
      tripReason = "max_consecutive_losses";
    }

    // 7.c) New positions detection during cooldown
    const currentNetMap = {};
    for (const p of net) {
      currentNetMap[p.tradingsymbol] = safeNum(p.net_quantity);
    }

    if (cooldownActive && nowTs < cooldownUntil) {
      for (const sym of Object.keys(currentNetMap)) {
        const oldQty = safeNum(lastNetPositions[sym] || 0);
        const newQty = safeNum(currentNetMap[sym] || 0);
        const dQty = newQty - oldQty;

        if (dQty !== 0) {
          await squareOffDelta(kc, sym, dQty);
          // you can later extend: store detailed cooldown violation logs in state
        }
      }
    }

    patch.last_net_positions = currentNetMap;

    // 7.d) Loss-floor logic (adapted from enforce-trades)
    let maxLossAbs = safeNum(s.max_loss_abs || 0);
    if (!maxLossAbs) {
      const capital = safeNum(s.capital_day_915 || 0);
      const pct = safeNum(s.max_loss_pct || 0);
      if (capital > 0 && pct > 0) {
        maxLossAbs = Math.round(capital * pct / 100);
      }
    }

    const trailStep = safeNum(s.trail_step_profit || 0);

    const currentFloor = Number.isFinite(Number(s.active_loss_floor))
      ? safeNum(s.active_loss_floor)
      : (maxLossAbs ? -maxLossAbs : 0);

    const currentPeak = safeNum(s.peak_profit || 0);

    let nextPeak = currentPeak;
    if (total > currentPeak) nextPeak = total;

    let trailLevel = 0;
    if (trailStep && nextPeak > 0) {
      trailLevel = Math.floor(nextPeak / trailStep) * trailStep;
    }

    let newFloorCandidate = (trailLevel > 0 && maxLossAbs > 0)
      ? trailLevel - maxLossAbs
      : -maxLossAbs;

    let nextFloor = currentFloor;
    if (newFloorCandidate > nextFloor) nextFloor = newFloorCandidate;

    const remaining = total - nextFloor;

    patch.peak_profit = nextPeak;
    patch.max_loss_abs = maxLossAbs;
    patch.active_loss_floor = nextFloor;
    patch.remaining_to_max_loss = remaining;

    if (maxLossAbs > 0 && remaining <= 0) {
      trippedDay = true;
      blockNew = true;
      tripReason = "max_loss_floor_total_pnl";
    }

    patch.tripped_day = trippedDay;
    patch.block_new_orders = blockNew;
    patch.trip_reason = tripReason;

    // 8) If tripped now → enforce
    if (trippedDay) {
      const cancelled = await cancelPending(kc);
      const squared = await squareOffAll(kc);

      patch.admin_last_enforce_result = {
        cancelled,
        squared,
        at: nowTs,
        reason: tripReason || "day_tripped_enforce"
      };
    }

    // 9) Persist via setState (canonical) + daily snapshot
    const nextState = await setState(patch);
    await kv.set(dayKey, nextState);

    return res.json({
      ok: true,
      realised,
      unrealised,
      total_pnl: total,
      tripped_day: nextState.tripped_day,
      block_new_orders: nextState.block_new_orders,
      trip_reason: nextState.trip_reason || null
    });

  } catch (err) {
    console.error("risk-engine ERROR:", err);
    await setState({
      kite_status: "error",
      kite_error_message: String(err)
    });
    return res.status(500).json({ ok: false, error: String(err) });
  }
}


// === PATCHES ADDED ===

// MAX PROFIT TARGET
async function __applyMaxProfit__(s, total) {
  let maxProfitAbs = Number(s.max_profit_abs || 0);
  if (!maxProfitAbs) {
    maxProfitAbs = (Number(s.capital_day_915||0) * Number(s.max_profit_pct||0)) / 100;
  }
  return (maxProfitAbs > 0 && total >= maxProfitAbs);
}

// ALLOW NEW LOGIC
async function __applyAllowNewLogic__(kc, allowNew, cooldownActive, curr, old) {
  if (!allowNew && !cooldownActive) {
    for (const sym of Object.keys(curr)) {
      const d = Number(curr[sym]||0) - Number(old[sym]||0);
      if (d > 0) {
        try {
          await kc.placeOrder("regular", {
            exchange: "NFO",
            tradingsymbol: sym,
            transaction_type: "SELL",
            quantity: d,
            order_type: "MARKET",
            product: "MIS",
            validity: "DAY"
          });
        } catch(e){}
      }
    }
  }
}

// COOLDOWN ON PROFIT FLAG EXAMPLE STUB
function __cooldownOnProfitAllowed__(delta, flag){
  if (delta > 0 && !flag) return false;
  return true;
}

