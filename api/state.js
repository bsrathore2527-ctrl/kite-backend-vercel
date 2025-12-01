import { kv } from "./_lib/kv.js";
import { createKiteInstanceForCurrentUser } from "./_lib/kite-current-instance.js";

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ ok:false, error:"Missing user_id" });
    }

    const userInfo = await kv.get(`user:${user_id}:info`);
    if (!userInfo) {
      return res.status(401).json({ ok:false, error:"Unauthorized user" });
    }

    // Load stored state
    const st = (await kv.get(`user:${user_id}:state`)) || {};

    // STATIC USER-SPECIFIC DATA
    const realised = Number(st.realised || 0);
    const capital = Number(st.capital_day_915 || 0);
    const maxLossPct = Number(st.max_loss_pct || 0);
    const maxProfitPct = Number(st.max_profit_pct || 0);

    // Fetch live Zerodha data ONLY for the single active session
    let unreal = 0, positions = [], funds = {}, kite_status = "disconnected";

    try {
      const kc = await createKiteInstanceForCurrentUser();
      const pos = await kc.getPositions();
      const f = await kc.getFunds();

      positions = pos.net || [];
      funds = f.equity || {};

      unreal = positions.reduce((t, p) => t + Number(p.unrealised || 0), 0);
      kite_status = "connected";

    } catch (e) {
      console.error("Kite fetch error:", e.message);
    }

    const total = realised + unreal;

    return res.status(200).json({
      ok: true,
      user_id,
      kite_status,

      state: {
        realised,
        unrealised: unreal,
        total,

        capital_day_915: capital,
        max_loss_pct: maxLossPct,
        max_profit_pct: maxProfitPct,

        active_loss_floor: Number(st.active_loss_floor || 0),
        remaining_to_max_loss: Number(st.remaining_to_max_loss || 0),

        consecutive_losses: Number(st.consecutive_losses || 0),
        cooldown_active: !!st.cooldown_active,

        tripped: !!st.tripped,
        tripped_day: !!st.tripped_day,

        last_trade_time: Number(st.last_trade_time || 0),

        positions,
        funds
      }
    });

  } catch (err) {
    console.error("state API error:", err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
