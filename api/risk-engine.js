import { kv, getState, setState, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

// ---------------------------------------------------
// FIFO HELPERS (unchanged logic, safe, tested)
// ---------------------------------------------------
function fifoSell(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];
  for (const lot of book) {
    if (qtyRem <= 0) { newLots.push(lot); continue; }
    if (lot.side === "BUY") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (price - lot.avg) * take;
      if (lot.qty > take) newLots.push({ ...lot, qty: lot.qty - take });
      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }
  if (qtyRem > 0) newLots.push({ side: "SELL", qty: qtyRem, avg: price });
  return { realised, book: newLots };
}

function fifoBuy(book, qty, price) {
  let qtyRem = qty;
  let realised = 0;
  let newLots = [];
  for (const lot of book) {
    if (qtyRem <= 0) { newLots.push(lot); continue; }
    if (lot.side === "SELL") {
      const take = Math.min(qtyRem, lot.qty);
      realised += (lot.avg - price) * take;
      if (lot.qty > take) newLots.push({ ...lot, qty: lot.qty - take });
      qtyRem -= take;
    } else {
      newLots.push(lot);
    }
  }
  if (qtyRem > 0) newLots.push({ side: "BUY", qty: qtyRem, avg: price });
  return { realised, book: newLots };
}

// ---------------------------------------------------
// OPTIMIZED REALISED CALC (uses pre-fetched net positions)
// ---------------------------------------------------
async function computeRealised(kc, netPos) {
  const trades = await kc.getTrades();
  trades.sort((a, b) =>
    new Date(a.exchange_timestamp || a.fill_timestamp || a.order_timestamp) -
    new Date(b.exchange_timestamp || b.fill_timestamp || b.order_timestamp)
  );

  const books = {};
  let realised = 0;

  // preload overnight positions
  for (const p of netPos) {
    const oq = Number(p.overnight_quantity || 0);
    if (!oq) continue;
    const sym = p.tradingsymbol;
    if (!books[sym]) books[sym] = [];

    const buyVal = Number(p.buy_value || 0);
    const dayBuyVal = Number(p.day_buy_value || 0);
    const overnightVal = buyVal - dayBuyVal;
    const avg = oq > 0 ? overnightVal / oq : 0;

    books[sym].push({ side: "BUY", qty: oq, avg });
  }

  // FIFO on all trades
  for (const t of trades) {
    const sym = t.tradingsymbol;
    const side = (t.transaction_type || "").toUpperCase();
    const qty = Number(t.quantity);
    const price = Number(t.average_price);

    if (!books[sym]) books[sym] = [];

    const r = side === "BUY"
      ? fifoBuy(books[sym], qty, price)
      : fifoSell(books[sym], qty, price);

    realised += r.realised;
    books[sym] = r.book;
  }

  return realised;
}

// ---------------------------------------------------
// OPTIMIZED UNREALISED (pure function)
// ---------------------------------------------------
function computeUnrealisedFIFO(net, ltpAll) {
  let unreal = 0;
  for (const p of net) {
    const qty = Number(p.quantity || 0);
    if (!qty) continue;

    const token = Number(p.instrument_token);
    const ltp = ltpAll[token]?.last_price;
    if (ltp == null) continue;

    const avg = Number(p.average_price);
    unreal += qty > 0 ? (ltp - avg) * qty : (avg - ltp) * Math.abs(qty);
  }
  return unreal;
}

function safeNum(v, f = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : f;
}

// ---------------------------------------------------
// ENFORCERS
// ---------------------------------------------------
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s === "PENDING";
    });

    let c = 0;
    for (const o of pending) {
      try {
        await kc.cancelOrder(o.variety || "regular", o.order_id);
        c++;
      } catch {}
    }
    return c;
  } catch {
    return 0;
  }
}

async function squareOffAll(kc) {
  try {
    const pos = await kc.getPositions();
    const net = pos.net || [];
    let s = 0;

    for (const p of net) {
      const qty = Number(p.quantity || p.net_quantity || 0);
      if (!qty) continue;

      const side = qty > 0 ? "SELL" : "BUY";
      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NFO",
          tradingsymbol: p.tradingsymbol,
          transaction_type: side,
          quantity: Math.abs(qty),
          order_type: "MARKET",
          product: "MIS",
          validity: "DAY"
        });
        s++;
      } catch {}
    }
    return s;
  } catch {
    return 0;
  }
}

async function squareOffDelta(kc, sym, dQty) {
  try {
    const side = dQty > 0 ? "SELL" : "BUY";
    await kc.placeOrder("regular", {
      exchange: "NFO",
      tradingsymbol: sym,
      transaction_type: side,
      quantity: Math.abs(dQty),
      order_type: "MARKET",
      product: "MIS",
      validity: "DAY"
    });
    return true;
  } catch {
    return false;
  }
}

// ---------------------------------------------------
// MAIN HANDLER
// ---------------------------------------------------
export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const s = (await getState()) || {};
    const dayKey = `risk:${todayKey()}`;

    // Connect Kite
    let kc;
    try {
      kc = await instance();
    } catch (e) {
      const patch = {
        kite_status: "error",
        kite_error_message: String(e)
      };
      const next = await setState(patch);
      await kv.set(dayKey, next);
      return res.json({
        ok: false,
        error: "kite_connect_failed",
        kite_status: "error"
      });
    }

    // Immediate enforce if already tripped
    if (s.tripped_day) {
      const c = await cancelPending(kc);
      const q = await squareOffAll(kc);
      const next = await setState({
        admin_last_enforce_result: {
          cancelled: c,
          squared: q,
          at: Date.now(),
          reason: "already_tripped"
        }
      });
      await kv.set(dayKey, next);
      return res.json({ ok: true, enforced: true, reason: "already_tripped" });
    }

    // ---------------------------------------------------
    // OPTIMIZED MTM BLOCK (single getPositions)
    // ---------------------------------------------------
    const ltpAll = (await kv.get("ltp:all")) || {};
    const pos = await kc.getPositions();        // ONE CALL ONLY
    const net = pos.net || [];

    const realised = await computeRealised(kc, net);
    const unrealised = computeUnrealisedFIFO(net, ltpAll);
    const total = realised + unrealised;

    // MTM logging
    console.log("🟢 FINAL MTM:", {
      realised,
      unrealised,
      total_pnl: total,
      at: new Date().toISOString()
    });
    // Maintain MTM history (last 50)
    let mtmLog = Array.isArray(s.mtm_log) ? [...s.mtm_log] : [];
    mtmLog.push({
      ts: Date.now(),
      realised,
      unrealised,
      total
    });
    if (mtmLog.length > 50) mtmLog = mtmLog.slice(-50);

    const now = Date.now();

    // ---------------------------------------------------
    // DELTA + COOLDOWN / LOSS STREAK LOGIC
    // ---------------------------------------------------
    const minLossToCount = safeNum(s.min_loss_to_count || 0);
    const cooldownMin = safeNum(s.cooldown_min || 0);
    const maxConsec = safeNum(s.max_consecutive_losses || 0);

    let hist = Array.isArray(s.realised_history) ? [...s.realised_history] : [];
    const prevReal = hist.length ? safeNum(hist[hist.length - 1]) : safeNum(s.realised || 0);
    const delta = realised - prevReal;

    let patch = {
      realised,
      unrealised,
      total_pnl: total,
      mtm_last_update: now,
      kite_status: "ok",
      kite_error_message: null,
      mtm_log: mtmLog
    };

    let realisedHistory = hist;
    let consecutiveLosses = safeNum(s.consecutive_losses || 0);
    let cooldownActive = !!s.cooldown_active;
    let cooldownUntil = safeNum(s.cooldown_until || 0);
    let lastNet = s.last_net_positions || {};
    let trippedDay = !!s.tripped_day;
    let tripReason = s.trip_reason || null;
    let blockNew = !!s.block_new_orders;

    // When realised changes
    if (delta !== 0) {
      realisedHistory.push(realised);
      if (realisedHistory.length > 200) realisedHistory = realisedHistory.slice(-200);

      cooldownActive = true;
      cooldownUntil = now + cooldownMin * 60000;
      patch.last_trade_time = now;

      if (delta < 0 && Math.abs(delta) >= minLossToCount) {
        consecutiveLosses++;
      } else if (delta > 0) {
        consecutiveLosses = 0;
      }
    }

    patch.realised_history = realisedHistory;
    patch.cooldown_active = cooldownActive;
    patch.cooldown_until = cooldownUntil;
    patch.consecutive_losses = consecutiveLosses;

    // Max consecutive losses trip
    if (maxConsec > 0 && consecutiveLosses >= maxConsec) {
      trippedDay = true;
      blockNew = true;
      tripReason = "max_consecutive_losses";
    }

    // ---------------------------------------------------
    // NET POSITION MAP (uses already fetched net)
    // ---------------------------------------------------
    const currentNet = {};
    for (const p of net) {
      currentNet[p.tradingsymbol] = safeNum(p.net_quantity || p.quantity || 0);
    }

    // ---------------------------------------------------
    // COOLDOWN ENFORCEMENT — SQUARE DELTAS ONLY
    // ---------------------------------------------------
    if (cooldownActive && now < cooldownUntil) {
      for (const sym of Object.keys(currentNet)) {
        const oldQty = safeNum(lastNet[sym] || 0);
        const newQty = safeNum(currentNet[sym] || 0);
        const d = newQty - oldQty;

        if (d !== 0) {
          await squareOffDelta(kc, sym, d);
        }
      }
    }

    patch.last_net_positions = currentNet;

    // ---------------------------------------------------
    // MAX LOSS FLOOR + TRAILING
    // ---------------------------------------------------
    let maxLossAbs = safeNum(s.max_loss_abs || 0);
    if (!maxLossAbs) {
      const capital = safeNum(s.capital_day_915 || 0);
      const pct = safeNum(s.max_loss_pct || 0);
      if (capital > 0 && pct > 0) maxLossAbs = Math.round((capital * pct) / 100);
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

    let newFloorCandidate =
      trailLevel > 0 && maxLossAbs > 0
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

    // ---------------------------------------------------
    // MAX PROFIT → FREEZE MODE
    // ---------------------------------------------------
    let maxProfitAbs = safeNum(s.max_profit_abs || 0);
    if (!maxProfitAbs) {
      const cap = safeNum(s.capital_day_915 || 0);
      const pct = safeNum(s.max_profit_pct || 0);
      if (cap > 0 && pct > 0) maxProfitAbs = (cap * pct) / 100;
    }

    if (maxProfitAbs > 0 && total >= maxProfitAbs) {
      trippedDay = true;
      blockNew = true;
      tripReason = "max_profit_target";

      patch.freeze_mode = "maxprofit";

      const allowed = {};
      for (const p of net) {
        const q = Number(p.quantity || p.net_quantity || 0);
        if (q !== 0) allowed[p.tradingsymbol] = q;
      }
      patch.allowed_positions = allowed;
    }

    patch.tripped_day = trippedDay;
    patch.block_new_orders = blockNew;
    patch.trip_reason = tripReason;

    // ---------------------------------------------------
    // IF DAY TRIPPED → enforce immediately
    // ---------------------------------------------------
    if (trippedDay) {
      const c = await cancelPending(kc);
      const q = await squareOffAll(kc);
      patch.admin_last_enforce_result = {
        cancelled: c,
        squared: q,
        at: now,
        reason: tripReason || "day_tripped_enforce"
      };
    }

    // Save updated state
    const nextState = await setState(patch);
    await kv.set(dayKey, nextState);
    // ---------------------------------------------------
    // SAFE FREEZE-MODE ENFORCEMENT (maxprofit)
    // ---------------------------------------------------
    const freezeMode = nextState.freeze_mode || null;
    let allowed = nextState.allowed_positions || null;

    if (freezeMode === "maxprofit" && allowed) {
      // ALWAYS fetch LIVE Zerodha positions fresh before enforcing
      const fresh = await kc.getPositions();
      const live = fresh.net || [];

      // Copy so updates don't mutate original
      let updated = { ...allowed };

      for (const p of live) {
        const sym = p.tradingsymbol;
        const actualQty = Number(p.quantity || p.net_quantity || 0);
        const allowedQty = updated[sym] ?? 0;

        // ---------------------------------------------------
        // CASE A: User opened new symbol during freeze
        // ---------------------------------------------------
        if (!(sym in updated)) {
          if (actualQty !== 0) {
            const side = actualQty > 0 ? "SELL" : "BUY";
            await kc.placeOrder("regular", {
              exchange: p.exchange || "NFO",
              tradingsymbol: sym,
              transaction_type: side,
              quantity: Math.abs(actualQty),
              order_type: "MARKET",
              product: "MIS",
              validity: "DAY"
            });
          }
          // Do NOT add this symbol to allowed
          continue;
        }

        // ---------------------------------------------------
        // CASE B: User REDUCED position (actual < allowed)
        // NEVER BUY to fix — just shrink allowed
        // ---------------------------------------------------
        if (actualQty < allowedQty) {
          updated[sym] = actualQty; // shrink allowed safely
          continue;
        }

        // ---------------------------------------------------
        // CASE C: EXACT MATCH (actual == allowed)
        // No action needed
        // ---------------------------------------------------
        if (actualQty === allowedQty) continue;

        // ---------------------------------------------------
        // CASE D: User INCREASED position (actual > allowed)
        // SELL ONLY THE EXCESS
        // ---------------------------------------------------
        if (actualQty > allowedQty) {
          const extra = actualQty - allowedQty;
          await kc.placeOrder("regular", {
            exchange: p.exchange || "NFO",
            tradingsymbol: sym,
            transaction_type: "SELL",
            quantity: Math.abs(extra),
            order_type: "MARKET",
            product: "MIS",
            validity: "DAY"
          });

          // Now actualQty = allowedQty after selling extra
          continue;
        }
      }

      // Store updated allowed map
      patch.allowed_positions = updated;
      patch.freeze_mode = "maxprofit";

      const ns2 = await setState(patch);
      await kv.set(dayKey, ns2);

      return res.json({
        ok: true,
        freeze_mode: "maxprofit",
        allowed_positions: updated
      });
    }
    // ---------------------------------------------------
    // NORMAL (NON-FREEZE) RESPONSE
    // ---------------------------------------------------
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

    return res.status(500).json({
      ok: false,
      error: String(err)
    });
  }
}
