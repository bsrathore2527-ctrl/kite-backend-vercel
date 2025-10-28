// api/state.js — public/admin state (read-only unless admin uses /api/admin/*)
import { getState, todayKey, kv } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req);
    const s = await getState(); // primary state object
    const tok = await getAccessToken();

    // Check for an admin override stored in risk:{today}
    let override = null;
    try {
      const riskKey = `risk:${todayKey()}`;
      const r = await kv.get(riskKey);
      if (r && typeof r === "object" && (typeof r.capital_day_915 !== "undefined")) {
        override = r;
      }
    } catch (err) {
      // ignore kv read errors - not fatal
      console.warn("state: override check failed", err && err.message);
    }

    // Attempt to compute better 'unrealised' by asking Kite positions when available.
    // This uses several common fields from various kite clients (p.pnl, p.unrealised_pnl, p.day_pnl, etc.)
    let computedUnrealised = null;
    try {
      const kc = await instance(); // may throw if not connected
      if (kc) {
        const pos = await kc.getPositions();
        // many kite wrappers return pos.net (array) or pos?.data
        const netArr = pos?.net || pos?.data || pos || [];
        if (Array.isArray(netArr) && netArr.length > 0) {
          let sum = 0;
          for (const p of netArr) {
            // try common field names in order of likelihood
            const cand =
              p.pnl ??
              p.unrealised_pnl ??
              p.unrealised ??
              p.day_pnl ??
              p.day_unrealised ??
              p.netChange ??
              p.net_change ??
              p.realised_pnl ??
              p.m2m ??
              0;
            const n = Number(cand);
            if (Number.isFinite(n)) sum += n;
          }
          computedUnrealised = sum;
        }
      }
    } catch (e) {
      // Kite not connected or getPositions not available — ignore, we'll fallback
      // keep a console message for debugging
      // (Note: avoid throwing so this endpoint remains stable)
      // console.warn("state: compute unrealised failed", e && e.message);
    }

    // prefer computedUnrealised -> s.unrealised -> 0
    const unrealisedValue =
      (computedUnrealised !== null && typeof computedUnrealised !== "undefined")
        ? Number(computedUnrealised)
        : (s.unrealised !== undefined && s.unrealised !== null)
          ? Number(s.unrealised)
          : 0;

    // attempt to expose a sensible live_balance if stored in state
    // prefer live_balance (set by funds fetch) -> current_balance (cached) -> 0
    const liveBalance =
      (s.live_balance !== undefined && s.live_balance !== null)
        ? Number(s.live_balance)
        : (s.current_balance !== undefined && s.current_balance !== null)
          ? Number(s.current_balance)
          : 0;

    // compute cooldown_active boolean
    const nowTs = Date.now();
    const cooldownUntil = Number(s.cooldown_until || 0);
    const cooldownActive = cooldownUntil > nowTs;

    // apply admin override capital if present
    const capitalValue = (override && typeof override.capital_day_915 !== "undefined")
      ? Number(override.capital_day_915)
      : (s.capital_day_915 || 0);

    // safe view with defaults
    const safe = {
      capital_day_915: Number(capitalValue || 0),
      admin_override_capital: !!(override && override.admin_override_capital),
      realised: safeNum(s.realised, 0),
      unrealised: Number(unrealisedValue),
      current_balance: s.current_balance || 0, // cached balance (fallback for UI)
      live_balance: liveBalance,
      tripped_day: !!s.tripped_day,
      tripped_week: !!s.tripped_week,
      tripped_month: !!s.tripped_month,
      block_new_orders: !!s.block_new_orders,
      consecutive_losses: s.consecutive_losses || 0,
      cooldown_until: cooldownUntil,
      cooldown_active: !!cooldownActive,
      last_trade_time: s.last_trade_time || 0,
      last_trade_pnl: (typeof s.last_trade_pnl === "number" ? s.last_trade_pnl : (s.last_trade_pnl ? Number(s.last_trade_pnl) : 0)),
      profit_lock_10: !!s.profit_lock_10,
      profit_lock_20: !!s.profit_lock_20,
      expiry_flag: !!s.expiry_flag,
      // rules (expose for admin UI)
      max_loss_pct: s.max_loss_pct ?? 10,
      trail_step_profit: s.trail_step_profit ?? 5000,
      cooldown_min: s.cooldown_min ?? 15,
      max_consecutive_losses: s.max_consecutive_losses ?? 3,
      allow_new_after_lock10: s.allow_new_after_lock10 ?? false,
      week_max_loss_pct: s.week_max_loss_pct ?? null,
      month_max_loss_pct: s.month_max_loss_pct ?? null,
      // preserve any extra meta that might be useful in UI
      p10: s.p10 ?? s.p10_amount ?? null,
      p10_is_pct: typeof s.p10_is_pct !== 'undefined' ? !!s.p10_is_pct : null,
      admin_last_enforce_result: s.admin_last_enforce_result ?? null
    };

    // small debug hint — if computedUnrealised differs significantly from stored value, add a hint
    if (computedUnrealised !== null) {
      const stored = (s.unrealised !== undefined && s.unrealised !== null) ? Number(s.unrealised) : null;
      if (stored !== null && Math.abs(stored - computedUnrealised) > 1) {
        safe._unrealised_debug = { stored, computed: Number(computedUnrealised) };
      }
    }

    const now = new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
    res.setHeader("Cache-Control", "no-store").json({
      ok: true,
      time: now,
      admin,
      kite_status: tok ? "ok" : "not_logged_in",
      state: safe,
      key: todayKey()
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
