// api/state.js
// Provides the canonical state view for the Admin UI.
// - reads persisted state via getState() (from ./_lib/state.js)
// - augments with live Kite position/funds data (best-effort, safe)
// - returns both UTC and IST times

import { getState } from "./_lib/state.js";
import { instance } from "./_lib/kite.js";

function safeNumber(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function formatIst(nowMs = Date.now()) {
  return new Date(nowMs).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function handler(req, res) {
  try {
    const nowMs = Date.now();
    const time_utc = new Date(nowMs).toISOString();
    const time_ist = formatIst(nowMs);

    // Load persisted state (may be empty object)
    let persisted = {};
    try {
      persisted = (await getState()) || {};
    } catch (e) {
      console.warn("api/state: getState() failed, continuing with empty state.", e && e.message ? e.message : e);
      persisted = {};
    }

    // Prepare defaults and copy persisted values (non-destructive)
    const state = { ...persisted };

    // Live kite data placeholders
    let kite_status = "unknown";
    let live_unrealised = 0;
    let live_realised = 0;
    let live_total_pnl = 0;
    let current_balance = state.current_balance ?? 0;
    let live_balance = state.live_balance ?? 0;

    // Try to fetch Kite positions and funds
    try {
      const kc = await instance();
      // If instance() succeeds, kite is connected
      kite_status = "ok";

      // Try positions
      try {
        const pos = await kc.getPositions(); // shape depends on your wrapper
        const net = pos?.net ?? [];
        let totalMtm = 0;
        let realisedFromPos = 0;
        for (const p of net) {
          const m = safeNumber(p.m2m ?? p.unrealised ?? 0, 0);
          totalMtm += m;
          realisedFromPos += safeNumber(p.realised ?? p.realised_pnl ?? 0, 0);
        }
        live_unrealised = totalMtm;
        live_realised = realisedFromPos || 0;
        live_total_pnl = safeNumber(live_realised + live_unrealised, 0);
      } catch (e) {
        console.warn("api/state: getPositions failed", e && e.message ? e.message : e);
      }

      // Try funds / balances if available on Kite client
      try {
        let funds = null;
        if (typeof kc.getFunds === "function") {
          funds = await kc.getFunds();
        } else if (typeof kc.getMargins === "function") {
          funds = await kc.getMargins();
        }
        if (funds) {
          current_balance = safeNumber(funds.available_cash ?? funds.wallet_balance ?? funds.total ?? funds.equity ?? current_balance, current_balance);
          live_balance = safeNumber(funds.net ?? funds.equity ?? funds.available_margin ?? current_balance, current_balance);
        }
      } catch (e) {
        console.warn("api/state: balance/funds fetch failed", e && e.message ? e.message : e);
      }
    } catch (e) {
      kite_status = "error";
      console.warn("api/state: kite instance() failed", e && e.message ? e.message : e);
    }

    // Merge live values into the state view (without persisting)
    state.kite_status = kite_status;
    state.unrealised = safeNumber(live_unrealised, safeNumber(state.unrealised, 0));
    state.realised = safeNumber(live_realised, safeNumber(state.realised, 0));
    state.total_pnl = safeNumber(live_total_pnl, safeNumber(state.total_pnl, 0));
    state.current_balance = safeNumber(current_balance, safeNumber(state.current_balance, 0));
    state.live_balance = safeNumber(live_balance, safeNumber(state.live_balance, 0));

    // Compute p10 effective amount
    const p10 = safeNumber(state.p10 ?? 0, 0);
    const p10_is_pct = !!state.p10_is_pct;
    const capitalFromState = safeNumber(state.admin_override_capital ? state.capital_day_915 ?? 0 : state.capital_day_915 ?? 0, 0);
    const effectiveCapital = safeNumber(state.admin_override_capital ? state.capital_day_915 ?? state.admin_override_capital_amount ?? capitalFromState : capitalFromState, capitalFromState);

    let p10_effective_amount = 0;
    if (p10_is_pct) {
      p10_effective_amount = Math.round((p10 / 100) * effectiveCapital);
    } else {
      p10_effective_amount = safeNumber(state.p10_effective_amount ?? p10 ?? 0, 0);
    }
    state.p10_effective_amount = p10_effective_amount;

    // Compute absolute max loss if max_loss_pct present or max_loss_abs provided
    const max_loss_pct = safeNumber(state.max_loss_pct ?? 0, 0);
    let max_loss_abs = safeNumber(state.max_loss_abs ?? 0, 0);
    if (max_loss_abs === 0 && max_loss_pct > 0) {
      max_loss_abs = Math.round((max_loss_pct / 100) * effectiveCapital);
    }
    state.max_loss_abs = max_loss_abs;

    // Compute base loss floor and active loss floor
    const base_loss_abs = safeNumber(state.base_loss_abs ?? max_loss_abs ?? 0, max_loss_abs);
    state.base_loss_abs = base_loss_abs;

    const active_loss_floor = typeof state.active_loss_floor !== "undefined" ? safeNumber(state.active_loss_floor, -base_loss_abs) : -base_loss_abs;
    state.active_loss_floor = active_loss_floor;

    if (max_loss_abs > 0) {
      state.remaining_to_max_loss = Math.round(max_loss_abs + state.total_pnl);
    } else {
      state.remaining_to_max_loss = safeNumber(state.remaining_to_max_loss ?? 0, 0);
    }

    state.cooldown_min = safeNumber(state.cooldown_min ?? 15, 15);
    state.cooldown_until = safeNumber(state.cooldown_until ?? 0, 0);

    if (typeof state.last_trade_ts === "undefined" && typeof state.last_trade_iso !== "undefined") {
      const parsed = Date.parse(String(state.last_trade_iso || ""));
      if (!Number.isNaN(parsed)) state.last_trade_ts = parsed;
    }

    // update time fields in the returned object
    state.time_ms = nowMs;
    state.time_utc = time_utc;
    state.time = time_ist; // keep "time" as IST-friendly for UI (backwards compatible)

    // Return the composed view
    return res.status(200).json({
      ok: true,
      time_utc,
      time_ist,
      time_ms: nowMs,
      kite_status,
      state,
    });
  } catch (err) {
    console.error("api/state error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
