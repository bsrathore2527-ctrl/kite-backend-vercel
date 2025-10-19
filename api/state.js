// api/state.js
// Dual-mode: public (redacted) vs admin (full) based on Authorization header.

import { kv, todayKey, IST } from "./_lib/kv.js";
import { KiteConnect } from "kiteconnect";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  const nowTime = new Date().toLocaleTimeString("en-IN", { timeZone: IST, hour12: false });
  const auth = req.headers.authorization || "";
  const bearer = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  const isAdmin = !!process.env.ADMIN_TOKEN && bearer === process.env.ADMIN_TOKEN;

  try {
    const key = `risk:${todayKey()}`;
    const s = (await kv.get(key)) || {};

    // Base fields (safe for public)
    const base = {
      ok: true,
      time: nowTime,
      admin: isAdmin, // <— let the UI know if we’re in admin mode
      state: {
        capital_day_915: Number(s.capital_day_915 || 0),
        realised: Number(s.realised || 0),
        unrealised: Number(s.unrealised || 0),
        tripped_day: !!s.tripped_day,
        tripped_week: !!s.tripped_week,
        tripped_month: !!s.tripped_month,
        block_new_orders: !!s.block_new_orders,
        consecutive_losses: Number(s.consecutive_losses || 0),
        cooldown_until: s.cooldown_until || 0,
        profit_lock_10: !!s.profit_lock_10,
        profit_lock_20: !!s.profit_lock_20,
        expiry_flag: !!s.expiry_flag,
      },
    };

    if (!isAdmin) {
      // Public/trader view: redacted, no Kite health, no knobs
      return res.json(base);
    }

    // ADMIN EXTRAS
    let kite_status = "missing"; // "ok" | "invalid" | "missing"
    const at = await kv.get(`kite_at:${todayKey()}`);
    if (at) {
      try {
        const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
        kc.setAccessToken(at);
        await kc.getProfile(); // cheap health check
        kite_status = "ok";
      } catch {
        kite_status = "invalid";
      }
    }

    return res.json({
      ...base,
      kite_status,
      state: {
        ...base.state,
        // knobs / admin-only fields
        max_loss_pct: s.max_loss_pct ?? 10,
        trail_step_profit: s.trail_step_profit ?? 5000,
        cooldown_min: s.cooldown_min ?? 15,
        max_consecutive_losses: s.max_consecutive_losses ?? 3,
        allow_new_after_lock10: !!s.allow_new_after_lock10,
        week_max_loss_pct: s.week_max_loss_pct,
        month_max_loss_pct: s.month_max_loss_pct,
      },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
