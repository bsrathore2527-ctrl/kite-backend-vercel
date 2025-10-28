// api/state.js — full safe version
// Keeps all your original UI fields, adds tradebook summary & robust PnL handling.

import { getState, todayKey, kv } from "./_lib/kv.js";
import { getAccessToken } from "./_lib/kite.js";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req);
    const s = await getState(); // current state
    const tok = await getAccessToken();

    // --- Admin override capital (from risk:YYYY-MM-DD) ---
    let override = null;
    try {
      const riskKey = `risk:${todayKey()}`;
      const r = await kv.get(riskKey);
      if (r && typeof r === "object" && (typeof r.capital_day_915 !== "undefined")) {
        override = r;
      }
    } catch (err) {
      console.warn("state: override check failed:", err?.message);
    }

    // --- Live / Current balance preference ---
    const liveBalance =
      (s.live_balance !== undefined && s.live_balance !== null)
        ? Number(s.live_balance)
        : (s.current_balance !== undefined && s.current_balance !== null)
          ? Number(s.current_balance)
          : 0;

    // --- Cooldown calculation ---
    const nowTs = Date.now();
    const cooldownUntil = Number(s.cooldown_until || 0);
    const cooldownActive = cooldownUntil > nowTs;

    // --- Admin override capital handling ---
    const capitalValue = (override && typeof override.capital_day_915 !== "undefined")
      ? Number(override.capital_day_915)
      : (s.capital_day_915 || 0);

    // --- Read tradebook summary (safe) ---
    let tradebookCount = 0;
    try {
      const tb = await kv.get("guardian:tradebook");
      if (Array.isArray(tb)) tradebookCount = tb.length;
    } catch (e) {
      // non-fatal
    }

    // --- Build full safe state for UI (preserving original fields) ---
    const safe = {
      capital_day_915: Number(capitalValue || 0),
      admin_override_capital: !!(override && override.admin_override_capital),
      realised: Number(s.realised || 0),
      unrealised: Number(s.unrealised || 0),
      current_balance: Number(s.current_balance || 0),
      live_balance: liveBalance,

      tripped_day: !!s.tripped_day,
      tripped_week: !!s.tripped_week,
      tripped_month: !!s.tripped_month,
      block_new_orders: !!s.block_new_orders,

      consecutive_losses: Number(s.consecutive_losses || 0),
      cooldown_until: cooldownUntil,
      cooldown_active: !!cooldownActive,
      last_trade_time: Number(s.last_trade_time || 0),
      last_trade_pnl: Number(s.last_trade_pnl || 0),

      profit_lock_10: !!s.profit_lock_10,
      profit_lock_20: !!s.profit_lock_20,
      expiry_flag: !!s.expiry_flag,

      // --- rule configs (preserved fully) ---
      max_loss_pct: Number(s.max_loss_pct ?? 10),
      trail_step_profit: Number(s.trail_step_profit ?? 5000),
      cooldown_min: Number(s.cooldown_min ?? 15),
      max_consecutive_losses: Number(s.max_consecutive_losses ?? 3),
      allow_new_after_lock10: !!s.allow_new_after_lock10,
      week_max_loss_pct: s.week_max_loss_pct ?? null,
      month_max_loss_pct: s.month_max_loss_pct ?? null,

      // --- behavioral config (newer) ---
      cooldown_on_profit: !!s.cooldown_on_profit,
      min_loss_to_count: Number(s.min_loss_to_count ?? 0),

      // --- profit locks (p10 fields) ---
      p10: (typeof s.p10 !== "undefined") ? s.p10 : (typeof s.p10_amount !== "undefined" ? s.p10_amount : 0),
      p10_is_pct: !!s.p10_is_pct,

      // --- utility data for admin dashboard ---
      tradebook_count: tradebookCount,
      last_enforced_at: s.last_enforced_at || null,
      admin_last_enforce_result: s.admin_last_enforce_result || null,
      trip_reason: s.trip_reason || null
    };

    // --- Return structured response for admin UI ---
    const now = new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false
    });

    res.setHeader("Cache-Control", "no-store").json({
      ok: true,
      time: now,
      admin,
      kite_status: tok ? "ok" : "not_logged_in",
      state: safe,
      key: todayKey()
    });
  } catch (e) {
    console.error("state handler error:", e?.stack || e);
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
