// api/state.js
// CLEAN MTM-ONLY VERSION (patch applied on your original file)
// PNL is always read from live:mtm only.
// All other fields come from persisted risk state.

import { kv, getState } from "./_lib/kv.js";

function nowMs() { return Date.now(); }
function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    /* ------------------------------------- LOAD RISK STATE ------------------------------------- */
    const persisted = await getState() || {};

    /* -------------------------------------- LOAD MTM ONLY --------------------------------------- */
    const mtm = await kv.get("live:mtm") || {
      realised: 0,
      unrealised: 0,
      total: 0,
      polled_at: null
    };

    const realised = safeNum(mtm.realised, 0);
    const unrealised = safeNum(mtm.unrealised, 0);
    const total_pnl = safeNum(mtm.total, realised + unrealised);

    /* ----------------------------------- CAPITAL & LOSS CONFIG ---------------------------------- */
    const capital = safeNum(persisted.capital_day_915 ?? 0, 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0, 0);
    const max_loss_abs = Math.round(capital * (maxLossPct / 100));

    const active_loss_floor = Number.isFinite(persisted.active_loss_floor)
      ? Number(persisted.active_loss_floor)
      : -max_loss_abs;

    const remaining_to_max_loss = Number.isFinite(persisted.remaining_to_max_loss)
      ? Number(persisted.remaining_to_max_loss)
      : (total_pnl - active_loss_floor);

    /* -------------------------------------- PROFIT LOCK (P10) ----------------------------------- */
    let p10 = safeNum(persisted.p10 ?? 0);
    // p10 is percentage, UI handles conversion

    /* -------------------------------------- PREP MERGED STATE ----------------------------------- */
    const mergedState = {
      ...persisted,

      /* REAL-TIME PNL (MTM-ONLY) */
      realised,
      unrealised,
      total_pnl,

      /* CAPITAL */
      capital_day_915: capital,
      max_loss_pct: maxLossPct,
      max_loss_abs,

      /* RISK ENGINE */
      active_loss_floor,
      remaining_to_max_loss,
      peak_profit: safeNum(persisted.peak_profit),
      consecutive_losses: safeNum(persisted.consecutive_losses),
      last_trade_time: safeNum(persisted.last_trade_time),

      /* TRAILING CONFIG */
      p10,
      trail_step_profit: safeNum(persisted.trail_step_profit),

      /* RULES */
      max_consecutive_losses: safeNum(persisted.max_consecutive_losses),
      cooldown_min: safeNum(persisted.cooldown_min),
      cooldown_on_profit: !!persisted.cooldown_on_profit,
      min_loss_to_count: safeNum(persisted.min_loss_to_count),

      /* FLAGS */
      allow_new: persisted.allow_new !== false,
      tripped_day: !!persisted.tripped_day,

      /* ADVANCED (for consecutive-loss & startup MTM ref) */
      start_day_mtm: safeNum(persisted.start_day_mtm),
      last_sell_mtm: safeNum(persisted.last_sell_mtm),

      /* HEALTH */
      kite_status: persisted.kite_status || "ok",
      kite_last_ok_at: safeNum(persisted.kite_last_ok_at),
      kite_error_message: persisted.kite_error_message || null,

      /* TIMESTAMPS */
      time_ms: nowMs(),
      time: new Date(nowMs()).toISOString()
    };

    /* --------------------------------------------- RETURN --------------------------------------------- */
    return res.status(200).json({
      ok: true,
      time: new Date().toLocaleTimeString("en-IN", {
        timeZone: "Asia/Kolkata",
        hour12: false
      }),
      kite_status: mergedState.kite_status,
      state: mergedState,
      unrealised,
      realised,
      total_pnl,
      polled_at: mtm.polled_at || null
    });

  } catch (err) {
    console.error("api/state error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
