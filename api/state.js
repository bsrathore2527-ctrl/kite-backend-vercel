// File: /api/state.js
import { kv } from "../_lib/kv.js";
import { getKiteForUser } from "../_lib/kite.js"; // we'll define this helper next

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "GET only" });
    }

    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // --- 1) Load per-user risk state from Redis ---
    const stateKey = `user:${user_id}:state`;
    let st = await kv.get(stateKey);
    if (!st || typeof st !== "object") st = {};

    // sensible defaults
    const capital = Number(st.capital_day_915 ?? 0);
    const maxLossPct = Number(st.max_loss_pct ?? 0);

    st.realised = Number(st.realised ?? 0);
    st.unrealised = Number(st.unrealised ?? 0);
    st.total_pnl = Number(st.total_pnl ?? st.realised + st.unrealised);
    st.max_loss_pct = maxLossPct;
    st.capital_day_915 = capital;
    st.active_loss_floor = Number(st.active_loss_floor ?? 0);
    st.remaining_to_max_loss = Number(st.remaining_to_max_loss ?? 0);
    st.consecutive_losses = Number(st.consecutive_losses ?? 0);
    st.cooldown_active = !!st.cooldown_active;
    st.tripped = !!(st.tripped || st.tripped_day);

    // p10 variants, for compatibility with old admin.html logic
    if (typeof st.p10 === "undefined" && typeof st.p10_amount !== "undefined") {
      // legacy rupee mode
      st.p10_amount = Number(st.p10_amount ?? 0);
    } else if (typeof st.p10 !== "undefined") {
      st.p10 = Number(st.p10 ?? 0);
    }

    // --- 2) Try to get live data from Zerodha for this user ---
    let kite_status = "not_logged_in";
    try {
      const kc = await getKiteForUser(user_id); // throws if no token / not logged in
      if (!kc) {
        kite_status = "not_logged_in";
      } else {
        // funds
        const funds = await kc.getFunds().catch(() => null);
        // positions
        const pos = await kc.getPositions().catch(() => null);

        // set live positions & funds on state for frontend
        if (pos && Array.isArray(pos.net)) {
          st.positions = pos.net;
          // compute unrealised from Zerodha if present
          let unreal = 0;
          for (const p of pos.net) {
            unreal += Number(p.unrealised || p.pnl || 0);
          }
          st.unrealised = unreal;
          st.total_pnl = st.realised + st.unrealised;
        }

        if (funds && funds.equity) {
          st.funds = funds.equity;
        }

        kite_status = "ok";
      }
    } catch (e) {
      console.error("state.js getKiteForUser error", e);
      kite_status = "error";
    }

    // --- 3) Respond with merged view ---
    return res.status(200).json({
      ok: true,
      time: Date.now(),
      kite_status,
      state: st
    });

  } catch (err) {
    console.error("STATE ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
