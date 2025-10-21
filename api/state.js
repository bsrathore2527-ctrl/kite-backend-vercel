// api/state.js — public/admin state (read-only unless admin uses /api/admin/*)
import { getState } from "./_lib/state.js";
import { todayKey } from "./_lib/kv.js";
import { getAccessToken } from "./_lib/kite.js";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    const admin = isAdmin(req);
    const s = await getState();
    const tok = await getAccessToken();

    // safe view with defaults
    const safe = {
      capital_day_915: s.capital_day_915 || 0,
      realised: s.realised || 0,
      unrealised: s.unrealised || 0,
      current_balance: s.current_balance || 0, // latest cached balance (fallback for UI)
      tripped_day: !!s.tripped_day,
      tripped_week: !!s.tripped_week,
      tripped_month: !!s.tripped_month,
      block_new_orders: !!s.block_new_orders,
      consecutive_losses: s.consecutive_losses || 0,
      cooldown_until: s.cooldown_until || 0,
      profit_lock_10: !!s.profit_lock_10,
      profit_lock_20: !!s.profit_lock_20,
      expiry_flag: !!s.expiry_flag,
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
    res.setHeader("Cache-Control", "no-store").json({
      ok: true,
      time: now,
      admin,
      kite_status: tok ? "ok" : "not_logged_in",
      state: safe,
      key: todayKey()
    });
  } catch (e) {
    // TEMP DEBUG: return full error stack so we can see what's crashing
    console.error("STATE API ERROR:", e);
    res.status(500).setHeader("Content-Type", "text/plain; charset=utf-8");
    res.send(String(e.stack || e.message || e));
  }
}
