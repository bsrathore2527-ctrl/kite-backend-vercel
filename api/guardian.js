// api/guardian.js

import { getState, todayKey } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";
import { updateState } from "./_lib/state.js";
import { cancelPending, squareOffAll } from "./enforce.js";

function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// ---------- LIVE MTM FETCH ----------
async function fetchLiveMtm() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return total;
  } catch (e) {
    console.error("LIVE MTM fetch error:", e?.message || e);
    return null;
  }
}

// ---------- AUTOMATIC ENFORCEMENT (max loss / max profit) ----------
async function enforceIfThresholdCrossed(state) {
  try {
    // Already tripped? Do nothing.
    if (state.tripped_day) return state;

    const liveMtm = await fetchLiveMtm();
    if (liveMtm === null) return state;

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);

    const now = Date.now();

    // ==== MAX LOSS ====
    if (maxLossAbs > 0 && liveMtm <= -maxLossAbs) {
      const next = {
        ...state,
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_loss_reached",
        last_enforced_at: now,
      };

      await updateState(() => next);

      try { await cancelPending(); } catch (e) { console.error("cancelPending", e); }
      try { await squareOffAll(); } catch (e) { console.error("squareOffAll", e); }

      return next;
    }

    // ==== MAX PROFIT ====
    if (maxProfitAmt > 0 && liveMtm >= maxProfitAmt) {
      const next = {
        ...state,
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_profit_reached",
        last_enforced_at: now,
      };

      await updateState(() => next);

      try { await cancelPending(); } catch (e) { console.error("cancelPending", e); }
      try { await squareOffAll(); } catch (e) { console.error("squareOffAll", e); }

      return next;
    }

    return state;
  } catch (err) {
    console.error("Auto-enforce check error:", err);
    return state;
  }
}

// ---------- ADMIN DASHBOARD MTM REFRESH ----------
async function refreshMtmSnapshots(state) {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);

    const now = Date.now();

    await updateState((s = {}) => {
      s.unrealised = total;
      s.realised = s.realised ?? 0;
      s.total_pnl = Number((s.realised ?? 0) + total);
      s.last_mtm = total;
      s.last_mtm_ts = now;
      s.last_sell_ts = s.last_sell_ts ?? 0;
      return s;
    });

    return await getState();
  } catch (e) {
    console.error("guardian refreshMtmSnapshots error:", e?.message || e);
    return state;
  }
}

// ---------- MAIN HANDLER ----------
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const admin = isAdmin(req);

    let s = await getState().catch(() => ({}));

    // Auto trip check ALWAYS happens (admin or not)
    s = await enforceIfThresholdCrossed(s);

    // Safe access token check
    let tok = null;
    try { tok = await getAccessToken(); } catch (e) { tok = null; }

    // Admin UI refresh of MTM if older than 30s
    const needsRefresh =
      admin &&
      (!s.last_mtm_ts || Date.now() - Number(s.last_mtm_ts) > 30000);

    if (needsRefresh) s = await refreshMtmSnapshots(s);

    const liveBalance =
      (s.live_balance !== undefined && s.live_balance !== null)
        ? Number(s.live_balance)
        : (s.current_balance !== undefined && s.current_balance !== null)
          ? Number(s.current_balance)
          : 0;

    const nowTs = Date.now();
    const cooldownUntil = Number(s.cooldown_until || 0);
    const cooldownActive = cooldownUntil > nowTs;

    const safe = {
      capital_day_915: s.capital_day_915 || 0,
      realised: s.realised || 0,
      unrealised: s.unrealised || 0,
      current_balance: s.current_balance || 0,
      live_balance: liveBalance,
      tripped_day: !!s.tripped_day,
      tripped_week: !!s.tripped_week,
      tripped_month: !!s.tripped_month,
      block_new_orders: !!s.block_new_orders,
      consecutive_losses: s.consecutive_losses || 0,
      cooldown_until: cooldownUntil,
      cooldown_active: !!cooldownActive,
      last_sell_ts: s.last_sell_ts || 0,
      last_mtm: s.last_mtm || 0,
      last_mtm_ts: s.last_mtm_ts || 0,
      last_trade_time: s.last_trade_time || 0,
      last_trade_pnl: typeof s.last_trade_pnl === "number"
        ? s.last_trade_pnl
        : Number(s.last_trade_pnl || 0),

      // rules
      max_loss_pct: s.max_loss_pct ?? 10,
      trail_step_profit: s.trail_step_profit ?? 5000,
      cooldown_min: s.cooldown_min ?? 15,
      max_consecutive_losses: s.max_consecutive_losses ?? 3,
      allow_new_after_lock10: s.allow_new_after_lock10 ?? false,
      week_max_loss_pct: s.week_max_loss_pct ?? null,
      month_max_loss_pct: s.month_max_loss_pct ?? null
    };

    const nowStr = new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false
    });

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      time: nowStr,
      admin,
      kite_status: tok ? "ok" : "not_logged_in",
      state: safe,
      key: todayKey()
    });

  } catch (e) {
    console.error("guardian handler error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
