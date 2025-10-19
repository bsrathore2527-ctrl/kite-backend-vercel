// api/state.js
// Lightweight state read for UI + Kite health

import { kv, todayKey, IST } from "./_lib/kv.js";
import { KiteConnect } from "kiteconnect";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store, no-cache, must-revalidate, max-age=0");
  const nowTime = new Date().toLocaleTimeString("en-IN", { timeZone: IST, hour12: false });

  // Default status
  let kite_status = "missing"; // "ok" | "invalid" | "missing"

  try {
    // Read risk state
    const key = `risk:${todayKey()}`;
    const s = (await kv.get(key)) || {};

    // Quick Kite token check
    const at = await kv.get(`kite_at:${todayKey()}`);
    if (!at) {
      kite_status = "missing";
    } else {
      try {
        const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
        kc.setAccessToken(at);
        // use a very light call; profile is fine and cached by Kite
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
        // knobs (show current)
        max_loss_pct: s.max_loss_pct ?? 10,
        trail_step_profit: s.trail_step_profit ?? 5000,
        cooldown_min: s.cooldown_min ?? 15,
        max_consecutive_losses: s.max_consecutive_losses ?? 3,
        allow_new_after_lock10: !!s.allow_new_after_lock10,
      },
    });
  } catch (e) {
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
}
