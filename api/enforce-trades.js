// ======================================================================
// MULTI-USER ENFORCE-TRADES.JS (FINAL PRODUCTION VERSION)
// - Uses Upstash KV correctly
// - No sellbook
// - Tradebook = Dictionary
// - Zero-qty positions retained (Model A)
// - Auto-add token to watchlist
// - min_loss_to_count applied
// - Consecutive-loss logic preserved
// - Max-loss breach triggers full exit
// - MTM from ticker-worker
// ======================================================================

import { kv } from "./_lib/kv.js";
import { getClientId } from "./kite.js";
import { cancelPending, squareOffAll } from "./_lib/exits.js";

export default async function handler(req) {
  try {
    const userId = await getClientId();
    if (!userId) {
      return json({ ok: false, error: "No userId found" });
    }

    // ----------------------------------------------------------
    // KV KEYS
    // ----------------------------------------------------------
    const stateKey = `state:${userId}`;
    const configKey = `config:${userId}`;
    const posKey = `positions:${userId}`;
    const tradebookKey = `tradebook:${userId}`;
    const watchKey = `watchlist:${userId}`;
    const mtmKey = `mtm:${userId}`;

    // ----------------------------------------------------------
    // LOAD BASIC DATA
    // ----------------------------------------------------------
    const config = (await kv.get(configKey)) || {};
    const state = (await kv.get(stateKey)) || {};
    const positions = (await kv.get(posKey)) || [];
    const tradebook = (await kv.get(tradebookKey)) || {};
    const watchlist = (await kv.get(watchKey)) || [];

    // ----------------------------------------------------------
    // CONFIG VALUES
    // ----------------------------------------------------------
    const maxLossAbs = Number(config.max_loss_abs || 0);
    const minLossToCount = Number(config.minimum_loss_to_count || 0);
    const maxConsec = Number(config.max_consecutive_losses || 0);

    // ----------------------------------------------------------
    // GET CURRENT LIVE MTM FROM WORKER
    // ----------------------------------------------------------
    const rawMTM = await kv.get(mtmKey);
    const currentMTM = Number(rawMTM || 0); // total PNL for today

    // ----------------------------------------------------------
    // BUILD QTY MAPS FOR POSITION REDUCTION DETECTION
    // ----------------------------------------------------------
    const prevQtyMap = state.prev_position_qty || {};
    const newQtyMap = {};

    for (const p of positions) {
      newQtyMap[p.token] = Number(p.qty || 0);
    }

    // Ensure watchlist auto-contains all tokens
    for (const token of Object.keys(newQtyMap)) {
      if (!watchlist.includes(Number(token))) {
        watchlist.push(Number(token));
      }
    }

    // ----------------------------------------------------------
    // TRADE DETECTION (POSITION REDUCTION)
    // ----------------------------------------------------------
    let tradeDetected = false;
    let tradeDetails = null;

    for (const token of Object.keys(newQtyMap)) {
      const oldQ = Number(prevQtyMap[token] || 0);
      const newQ = Number(newQtyMap[token]);

      if (newQ < oldQ) {
        tradeDetected = true;

        tradeDetails = {
          ts: Date.now(),
          token: Number(token),
          oldQty: oldQ,
          newQty: newQ,
          diffQty: newQ - oldQ
        };
      }
    }

    // ----------------------------------------------------------
    // TRADEBOOK UPDATE (dictionary)
    // ----------------------------------------------------------
    if (tradeDetected) {
      const tsKey = String(tradeDetails.ts);
      tradebook[tsKey] = tradeDetails;
      await kv.set(tradebookKey, tradebook);
    }

    // ----------------------------------------------------------
    // CONSECUTIVE LOSS LOGIC
    // ----------------------------------------------------------
    let nextConsecutive = Number(state.consecutive_losses || 0);
    let lastTradeMTM = Number(state.last_trade_mtm || 0);

    if (tradeDetected) {
      const tradePNL = currentMTM - lastTradeMTM;

      if (Math.abs(tradePNL) >= minLossToCount) {
        if (tradePNL < 0) nextConsecutive++;
        else nextConsecutive = 0; // profitable trade resets count
      }

      lastTradeMTM = currentMTM;
    }

    // ----------------------------------------------------------
    // TRIP FLAGS (CONSECUTIVE LOSS DOES NOT EXIT)
    // ----------------------------------------------------------
    let tripped = state.tripped_day || false;
    let tripReason = state.trip_reason || null;

    if (!tripped && maxConsec > 0 && nextConsecutive >= maxConsec) {
      tripped = true;
      tripReason = "max_consecutive_losses";
    }

    // ----------------------------------------------------------
    // MAX LOSS / TRAILING LOSS FLOOR BREACH (EXIT ENGINE)
    // ----------------------------------------------------------
    const remaining =
      maxLossAbs > 0 ? maxLossAbs - Math.abs(currentMTM) : 999999;

    if (!tripped && maxLossAbs > 0 && remaining <= 0) {
      tripped = true;
      tripReason = "max_loss_floor_live_mtm";

      // FULL EXIT ACTIONS
      try { await cancelPending(userId); } catch (e) {}
      try { await squareOffAll(userId); } catch (e) {}
    }

    // ----------------------------------------------------------
    // UPDATE STATE (MASTER STATE)
    // ----------------------------------------------------------
    const nextState = {
      ...state,
      consecutive_losses: nextConsecutive,
      last_trade_mtm: lastTradeMTM,
      prev_position_qty: newQtyMap,
      unrealised: currentMTM,
      total_pnl: currentMTM,
      remaining_to_max_loss: remaining,
      tripped_day: tripped,
      trip_reason: tripReason,
      last_update_ts: Date.now()
    };

    await kv.set(stateKey, nextState);
    await kv.set(watchKey, watchlist);

    return json({
      ok: true,
      tripped,
      tradeDetected,
      tripReason
    });

  } catch (err) {
    return json({ ok: false, error: err.message || String(err) });
  }
}

// --------------------------------------------------------------
// Helper: return JSON correctly inside a Vercel API route
// --------------------------------------------------------------
function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}
