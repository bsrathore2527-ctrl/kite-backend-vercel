// api/guardian.js
// Guardian endpoint — shows current state to admin UI.
// Also performs automatic immediate enforcement on max-loss / max-profit using live MTM.
// IMPORTANT: this file persists enforcement results directly into Upstash KV so /api/state is authoritative.

import { getState, todayKey, kv } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";
import { cancelPending, squareOffAll } from "./enforce.js";

function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// Fetch live MTM using Kite positions (same as dashboard)
async function fetchLiveMtm() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return total;
  } catch (e) {
    console.error("fetchLiveMtm error:", e && e.message ? e.message : e);
    return null;
  }
}

// Persist state object to authoritative KV key
async function persistStateObj(next) {
  try {
    await kv.put("guardian:state", JSON.stringify(next));
  } catch (e) {
    console.error("persistStateObj kv.put failed:", e && e.message ? e.message : e);
    throw e;
  }
}

// Read authoritative state from KV (convenience wrapper)
async function readStateObj() {
  try {
    const s = await getState();
    return s || {};
  } catch (e) {
    console.error("readStateObj getState error:", e && e.message ? e.message : e);
    return {};
  }
}

// Enforcement: if thresholds crossed, persist tripped state and attempt cancel/square
async function enforceIfThresholdCrossed(state) {
  try {
    if (!state) state = await readStateObj();
    if (state.tripped_day) return state; // already tripped

    const liveMtm = await fetchLiveMtm();
    const effectiveMtm = (liveMtm === null || typeof liveMtm === "undefined")
      ? Number(state.total_pnl ?? state.unrealised ?? state.last_mtm ?? 0)
      : Number(liveMtm);

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);

    const now = Date.now();

    // MAX LOSS
    if (maxLossAbs > 0 && effectiveMtm <= -maxLossAbs) {
      const next = {
        ...(state || {}),
        tripped_day: true,
        block_new_orders: true,
        trip_reason: "max_loss_reached",
        enforcement_meta: { by: "guardian_auto", mtm: effectiveMtm, maxLossAbs, at: now },
        last_enforced_at: now
      };

      // Persist tripped flag IMMEDIATELY (authoritative)
      await persistStateObj(next);

      // Attempt to cancel + square off; capture results for audit
      let cancelled = null;
      let squared = null;
      try {
        cancelled = await cancelPending();
      } catch (err) {
        console.error("cancelPending error:", err && err.message ? err.message : err);
        cancelled = { error: String(err) };
      }
      try {
        squared = await squareOffAll();
      } catch (err) {
        console.error("squareOffAll error:", err && err.message ? err.message : err);
        squared = { error: String(err) };
      }

      // Persist audit results
      const withAudit = {
        ...next,
        admin_last_enforce_result: { cancelled, squared, at: Date.now() }
      };
      await persistStateObj(withAudit);
      return withAudit;
    }

    // MAX PROFIT
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

      let cancelled = null;
      let squared = null;
      try {
        cancelled = await cancelPending();
      } catch (err) {
        console.error("cancelPending error:", err && err.message ? err.message : err);
        cancelled = { error: String(err) };
      }
      try {
        squared = await squareOffAll();
      } catch (err) {
        console.error("squareOffAll error:", err && err.message ? err.message : err);
        squared = { error: String(err) };
      }

      const withAudit = {
        ...next,
        admin_last_enforce_result: { cancelled, squared, at: Date.now() }
      };
      await persistStateObj(withAudit);
      return withAudit;
    }

    return state;
  } catch (err) {
    console.error("enforceIfThresholdCrossed error:", err && err.message ? err.message : err);
    return state;
  }
}

// Refresh MTM snapshots for admin UI (updates last_mtm/unrealised/total_pnl)
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

// Main handler
export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const admin = isAdmin(req);

    // Read current persisted state
    let s = await readStateObj();

    // Run automatic enforcement check immediately (this will persist if it trips)
    try {
      s = await enforceIfThresholdCrossed(s);
    } catch (e) {
      console.error("auto enforce check failed:", e && e.message ? e.message : e);
    }

    // Safe access token check (kite library may throw)
    let tok = null;
    try { tok = await getAccessToken(); } catch (e) { tok = null; }

    // If admin UI requests and snapshot is stale (older than 30s), refresh MTM snapshots
    const needsRefresh =
      admin &&
      (!s.last_mtm_ts || Date.now() - Number(s.last_mtm_ts) > 30000);

    if (needsRefresh) {
      try {
        s = await refreshMtmSnapshots(s);
      } catch (e) {
        console.error("refresh snapshot failed:", e && e.message ? e.message : e);
      }
    }

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

    const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });

    res.setHeader("Cache-Control", "no-store");
    return res.json({
      ok: true,
      time: now,
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
