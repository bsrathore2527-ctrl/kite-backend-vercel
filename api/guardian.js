// api/guardian.js

import { getState, todayKey, setState } from "./_lib/kv.js";
import { getAccessToken, instance } from "./_lib/kite.js";

function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function refreshMtmSnapshots(state) {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);

    const now = Date.now();

    // Update MTM fields (non-destructive)
    state.unrealised = total;
    state.realised = state.realised ?? 0;  // untouched
    state.total_pnl = total + (state.realised ?? 0);

    // 🔥 Update last_mtm snapshot (ONLY if changed)
    state.last_mtm = total;
    state.last_mtm_ts = now;

    // If last SELL exists, preserve the timestamp
    state.last_sell_ts = state.last_sell_ts ?? 0;

    await setState(state);

    return state;
  } catch (e) {
    console.error("guardian refreshMtmSnapshots error:", e?.message || e);
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

    // safe fetch of state
    let s = await getState().catch(() => ({}));

    // safe access token check
    let tok = null;
    try { tok = await getAccessToken(); } catch (e) { tok = null; }

    // ------ 🔥 NEW LOGIC ------
    // Auto-refresh MTM snapshots IF:
    // 1) Admin page requested
    // 2) State has no last_mtm or is stale
    const needsRefresh =
      admin &&
      (!s.last_mtm_ts || Date.now() - Number(s.last_mtm_ts) > 30000);

    if (needsRefresh) {
      s = await refreshMtmSnapshots(s);
    }
    // ------ END NEW LOGIC ------

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

      // 🔥 these two fields will ALWAYS be fresh now
      last_sell_ts: s.last_sell_ts || 0,
      last_mtm: s.last_mtm || 0,
      last_mtm_ts: s.last_mtm_ts || 0,

      last_trade_time: s.last_trade_time || 0,
      last_trade_pnl: (typeof s.last_trade_pnl === "number"
        ? s.last_trade_pnl
        : (s.last_trade_pnl ? Number(s.last_trade_pnl) : 0)),
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

    const now = new Date().toLocaleTimeString("en-IN", {
      timeZone: "Asia/Kolkata",
      hour12: false
    });

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
