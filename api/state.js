// api/state.js — public/admin state (read-only unless admin uses /api/admin/*)
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
      realised: s.realised || 0,
      unrealised: s.unrealised || 0,
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
      // behavioral flags
      cooldown_on_profit: !!s.cooldown_on_profit,
      min_loss_to_count: s.min_loss_to_count ?? 0
    };

    // --- ADD: fetch and include tradebook from KV (no new endpoint needed) ---
    let tradebook = [];
    try {
      const tb = await kv.get("guardian:tradebook");
      if (Array.isArray(tb)) {
        // return the most recent 50 trades in reverse chronological order
        tradebook = tb.slice(-50).reverse();
      }
    } catch (err) {
      console.warn("state: could not load tradebook", err && err.message);
    }
    // attach tradebook to safe object for admin UI visibility
    safe.tradebook = tradebook;

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
