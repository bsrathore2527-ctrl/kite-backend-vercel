// api/guardian.js
// FINAL STABLE VERSION – auto-enforces max-loss/max-profit and ALWAYS persists
// to the correct KV using setState()

import { getState } from "./_lib/kv.js";
import { setState } from "./_lib/state.js";
import { todayKey } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";
import { cancelPending, squareOffAll } from "./enforce.js";
import { kv } from "./_lib/kv.js"; // fallback

// ------------------------------------------------------------
// AUTH CHECK
// ------------------------------------------------------------
function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// ------------------------------------------------------------
// FETCH LIVE MTM (safe)
// ------------------------------------------------------------
async function fetchLiveMtmSafe() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return total;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------
// PERSISTENCE — always use setState first
// ------------------------------------------------------------
async function persistStateObj(next) {
  // Primary method
  try {
    await setState(next);
    return;
  } catch (err) {
    console.error("setState failed:", err);
  }

  // Fallback to kv.put
  try {
    if (kv && typeof kv.put === "function") {
      await kv.put("guardian:state", JSON.stringify(next));
      return;
    }
  } catch (err) {
    console.error("kv.put failed:", err);
  }

  // Fallback to kv.set
  try {
    if (kv && typeof kv.set === "function") {
      await kv.set("guardian:state", JSON.stringify(next));
      return;
    }
  } catch (err) {
    console.error("kv.set failed:", err);
  }

  throw new Error("No valid persistence method");
}

// ------------------------------------------------------------
// AUTO ENFORCEMENT LOGIC — max loss / max profit
// ------------------------------------------------------------
async function enforceIfThresholdCrossed(state) {
  try {
    state = state || await getState();

    if (state.tripped_day) return state;

    const liveMtm = await fetchLiveMtmSafe();
    const fallback = Number(state.total_pnl ?? state.unrealised ?? state.last_mtm ?? 0);
    const effectiveMtm = (liveMtm === null ? fallback : Number(liveMtm));

    // Debug write
    const debugState = {
      ...state,
      __debug_last_live_mtm: liveMtm,
      __debug_effective_mtm: effectiveMtm,
      __debug_enforce_attempt_ts: Date.now()
    };
    await persistStateObj(debugState);
    state = debugState;

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);
    const now = Date.now();

    // -------- MAX LOSS TRIP --------
    if (maxLossAbs > 0 && effectiveMtm <= -maxLossAbs) {
      const tripped = {
        ...state,
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_loss_reached",
        last_enforced_at: now,
        enforcement_meta: { by: "guardian_auto", effectiveMtm, maxLossAbs, at: now }
      };

      await persistStateObj(tripped);

      let cancelled = null, squared = null;
      try { cancelled = await cancelPending(); } catch (e) { cancelled = { error: String(e) }; }
      try { squared = await squareOffAll(); } catch (e) { squared = { error: String(e) }; }

      const final = { ...tripped, admin_last_enforce_result: { cancelled, squared, at: Date.now() } };
      await persistStateObj(final);
      return final;
    }

    // -------- MAX PROFIT TRIP --------
    if (maxProfitAmt > 0 && effectiveMtm >= maxProfitAmt) {
      const tripped = {
        ...state,
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_profit_reached",
        last_enforced_at: now,
        enforcement_meta: { by: "guardian_auto", effectiveMtm, maxProfitAmt, at: now }
      };

      await persistStateObj(tripped);

      let cancelled = null, squared = null;
      try { cancelled = await cancelPending(); } catch (e) { cancelled = { error: String(e) }; }
      try { squared = await squareOffAll(); } catch (e) { squared = { error: String(e) }; }

      const final = { ...tripped, admin_last_enforce_result: { cancelled, squared, at: Date.now() } };
      await persistStateObj(final);
      return final;
    }

    return state;

  } catch (err) {
    console.error("enforceIfThresholdCrossed error:", err);
    return state;
  }
}

// ------------------------------------------------------------
// OPTIONAL ADMIN SNAPSHOT REFRESH
// ------------------------------------------------------------
async function refreshMtmSnapshots(state) {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);

    const now = Date.now();
    const next = {
      ...state,
      unrealised: total,
      realised: state.realised ?? 0,
      total_pnl: Number((state.realised ?? 0) + total),
      last_mtm: total,
      last_mtm_ts: now
    };

    await persistStateObj(next);
    return next;
  } catch (err) {
    console.error("refreshMtmSnapshots error:", err);
    return state;
  }
}

// ------------------------------------------------------------
// MAIN HANDLER
// ------------------------------------------------------------
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const admin = isAdmin(req);

    let s = await getState();
    s = await enforceIfThresholdCrossed(s);

    let tok = null;
    try { tok = await getAccessToken(); } catch {}

    const nowTs = Date.now();
    const needsRefresh =
      admin &&
      (!s.last_mtm_ts || nowTs - Number(s.last_mtm_ts) > 30000);

    if (needsRefresh) {
      s = await refreshMtmSnapshots(s);
    }

    const cooldownUntil = Number(s.cooldown_until || 0);
    const safe = {
      capital_day_915: s.capital_day_915 || 0,
      realised: s.realised || 0,
      unrealised: s.unrealised || 0,
      current_balance: s.current_balance || 0,
      live_balance: s.live_balance || 0,
      tripped_day: !!s.tripped_day,
      tripped_week: !!s.tripped_week,
      tripped_month: !!s.tripped_month,
      block_new_orders: !!s.block_new_orders,
      consecutive_losses: s.consecutive_losses || 0,
      cooldown_until: cooldownUntil,
      cooldown_active: cooldownUntil > nowTs,
      last_sell_ts: s.last_sell_ts || 0,
      last_mtm: s.last_mtm || 0,
      last_mtm_ts: s.last_mtm_ts || 0,
      last_trade_time: s.last_trade_time || 0,
      last_trade_pnl: Number(s.last_trade_pnl || 0),
      max_loss_pct: s.max_loss_pct ?? 10,
      trail_step_profit: s.trail_step_profit ?? 5000,
      cooldown_min: s.cooldown_min ?? 15,
      max_consecutive_losses: s.max_consecutive_losses ?? 3,
      allow_new_after_lock10: s.allow_new_after_lock10 ?? false,
      week_max_loss_pct: s.week_max_loss_pct ?? null,
      month_max_loss_pct: s.month_max_loss_pct ?? null
    };

    const nowStr = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      time: nowStr,
      admin,
      kite_status: tok ? "ok" : "not_logged_in",
      state: safe,
      key: todayKey()
    });

  } catch (err) {
    console.error("guardian handler error:", err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
