// api/state-admin.js
import { kv, todayKey, IST } from "./_lib/kv.js";
import { KiteConnect } from "kiteconnect";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");

  // --- auth ---
  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== (process.env.ADMIN_TOKEN || "")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    const nowTime = new Date().toLocaleTimeString("en-IN", { timeZone: IST, hour12: false });

    // read state
    const key = `risk:${todayKey()}`;
    const s = (await kv.get(key)) || {};

    // kite health
    let kite_status = "missing";
    const at = await kv.get(`kite_at:${todayKey()}`);
    if (at) {
      try {
        const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
        kc.setAccessToken(at);
        await kc.getProfile();
        kite_status = "ok";
      } catch {
        kite_status = "invalid";
      }
    }

    return res.json({
      ok: true,
      time: nowTime,
      kite_status,
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
