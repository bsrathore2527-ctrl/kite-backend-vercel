// api/guardian.js
// Robust guardian with guaranteed enforcement fallback and instrumentation.
// Replaces previous file — writes authoritative state to Upstash KV ("guardian:state").

import { getState, todayKey, kv } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";
import { cancelPending, squareOffAll } from "./enforce.js";

function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function fetchLiveMtmSafe() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return total;
  } catch (e) {
    console.error("fetchLiveMtmSafe error:", e && e.message ? e.message : e);
    return null;
  }
}

async function persistStateObj(next) {
  try {
    await kv.put("guardian:state", JSON.stringify(next));
  } catch (e) {
    console.error("persistStateObj kv.put failed:", e && e.message ? e.message : e);
    throw e;
  }
}

async function readStateObj() {
  try {
    const s = await getState();
    return s || {};
  } catch (e) {
    console.error("readStateObj getState error:", e && e.message ? e.message : e);
    return {};
  }
}

// Main enforcement check with guaranteed fallback and instrumentation
async function enforceIfThresholdCrossed(state) {
  try {
    if (!state) state = await readStateObj();
    if (state.tripped_day) return state;

    // try live MTM
    const live = await fetchLiveMtmSafe();

    // compute effective MTM: prefer live, otherwise fall back to persisted values
    const fallback = Number(state.total_pnl ?? state.unrealised ?? state.last_mtm ?? 0);
    const effectiveMtm = (live === null || typeof live === "undefined") ? fallback : Number(live);

    // write debug info so we can see what was read
    try {
      const dbg = {
        ...(state || {}),
        __debug_last_live_mtm: live,
        __debug_effective_mtm: effectiveMtm,
        __debug_enforce_attempt_ts: Date.now()
      };
      await persistStateObj(dbg);
      state = dbg;
    } catch (e) {
      console.error("persist debug failed", e);
    }

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);
    const now = Date.now();

    // Immediate max-loss enforcement (no extra checks)
    if (maxLossAbs > 0 && effectiveMtm <= -maxLossAbs) {
      const next = {
        ...(state || {}),
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_loss_reached",
        enforcement_meta: { by: "guardian_auto", mtm: effectiveMtm, maxLossAbs, at: now },
        last_enforced_at: now
      };

      // persist immediately
      await persistStateObj(next);

      // attempt cancel & square
      let cancelled = null, squared = null;
      try { cancelled = await cancelPending(); } catch (e) { console.error("cancelPending error", e); cancelled = { error: String(e) }; }
      try { squared = await squareOffAll(); } catch (e) { console.error("squareOffAll error", e); squared = { error: String(e) }; }

      // persist audit
      const audited = { ...next, admin_last_enforce_result: { cancelled, squared, at: Date.now() } };
      await persistStateObj(audited);
      return audited;
    }

    // Immediate max-profit enforcement
    if (maxProfitAmt > 0 && effectiveMtm >= maxProfitAmt) {
      const next = {
        ...(state || {}),
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_profit_reached",
        enforcement_meta: { by: "guardian_auto", mtm: effectiveMtm, maxProfitAmt, at: now },
        last_enforced_at: now
      };

      await persistStateObj(next);

      let cancelled = null, squared = null;
      try { cancelled = await cancelPending(); } catch (e) { console.error("cancelPending error", e); cancelled = { error: String(e) }; }
      try { squared = await squareOffAll(); } catch (e) { console.error("squareOffAll error", e); squared = { error: String(e) }; }

      const audited = { ...next, admin_last_enforce_result: { cancelled, squared, at: Date.now() } };
      await persistStateObj(audited);
      return audited;
    }

    // Nothing to enforce — return current state
    return state;
  } catch (err) {
    console.error("enforceIfThresholdCrossed error:", err && err.message ? err.message : err);
    return state;
  }
}

async function refreshMtmSnapshots(state) {
  try {
    if (!state) state = await readStateObj();
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    const now = Date.now();
    const next = {
      ...(state || {}),
      unrealised: total,
      realised: state.realised ?? 0,
      total_pnl: Number((state.realised ?? 0) + total),
      last_mtm: total,
      last_mtm_ts: now,
      last_sell_ts: state.last_sell_ts ?? 0
    };
    await persistStateObj(next);
    return next;
  } catch (e) {
    console.error("refreshMtmSnapshots error:", e && e.message ? e.message : e);
    return state;
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const admin = isAdmin(req);

    // read authoritative state
    let s = await readStateObj();

    // run immediate enforcement check
    s = await enforceIfThresholdCrossed(s);

    // token check for kite
    let tok = null;
    try { tok = await getAccessToken(); } catch (e) { tok = null; }

    // refresh snapshots for admin if stale
    const needsRefresh = admin && (!s.last_mtm_ts || Date.now() - Number(s.last_mtm_ts) > 30000);
    if (needsRefresh) {
      s = await refreshMtmSnapshots(s);
    }

    const liveBalance = (s.live_balance !== undefined && s.live_balance !== null)
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
      last_trade_pnl: typeof s.last_trade_pnl === "number" ? s.last_trade_pnl : Number(s.last_trade_pnl || 0),
      // rules
      max_loss_pct: s.max_loss_pct ?? 10,
      trail_step_profit: s.trail_step_profit ?? 5000,
      cooldown_min: s.cooldown_min ?? 15,
      max_consecutive_losses: s.max_consecutive_losses ?? 3,
      allow_new_after_lock10: s.allow_new_after_lock10 ?? false,
      week_max_loss_pct: s.week_max_loss_pct ?? null,
      month_max_loss_pct: s.month_max_loss_pct ?? null
    };

    const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    res.setHeader("Cache-Control", "no-store");
    return res.json({ ok: true, time: now, admin, kite_status: tok ? "ok" : "not_logged_in", state: safe, key: todayKey() });
  } catch (e) {
    console.error("guardian handler error:", e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
