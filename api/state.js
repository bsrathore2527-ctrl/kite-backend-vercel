import { NextResponse } from "next/server";
import { kv } from "../../_lib/kv";
import { createKiteInstanceForUser } from "../../_lib/kite-user-instance";

export const dynamic = "force-dynamic";

export async function GET(req) {
  try {
    const { searchParams } = new URL(req.url);
    const user_id = searchParams.get("user_id");

    if (!user_id) {
      return NextResponse.json({ ok: false, error: "Missing user_id" });
    }

    // ------------------------------------------------------------
    // 1. Load user info
    // ------------------------------------------------------------
    const userInfo = await kv.get(`user:${user_id}:info`);
    if (!userInfo) {
      return NextResponse.json({ ok: false, error: "Unauthorized user" });
    }

    if (userInfo.expired) {
      return NextResponse.json({
        ok: true,
        expired: true,
        valid_until: userInfo.valid_until,
        message: "Subscription expired"
      });
    }

    // ------------------------------------------------------------
    // 2. Load user risk state
    // ------------------------------------------------------------
    const st = await kv.get(`user:${user_id}:state`) || {};

    // Ensure defaults
    const realised = Number(st.realised || 0);
    const capital = Number(st.capital_day_915 || 0);
    const maxLossPct = Number(st.max_loss_pct || 0);
    const maxProfitPct = Number(st.max_profit_pct || 0);

    let unreal = Number(st.unrealised || 0);

    let kite_status = "disconnected";
    let positions = [];
    let funds = {};

    // ------------------------------------------------------------
    // 3. Zerodha connection for live unrealised PNL
    // ------------------------------------------------------------
    try {
      const kc = await createKiteInstanceForUser(user_id);

      const pos = await kc.getPositions();
      const f = await kc.getFunds();

      positions = pos.net || [];
      funds = f?.equity || {};

      let unrealisedFromKite = 0;
      for (const p of positions) {
        unrealisedFromKite += Number(p.unrealised || 0);
      }
      unreal = unrealisedFromKite;

      kite_status = "connected";
    } catch (err) {
      console.log("Zerodha fetch failed for", user_id, err.message);
      // fallback to saved unrealised
    }

    const total = realised + unreal;

    // ------------------------------------------------------------
    // 4. Response
    // ------------------------------------------------------------
    return NextResponse.json({
      ok: true,
      kite_status,
      user_id,

      state: {
        realised,
        unrealised: unreal,
        total,

        capital_day_915: capital,
        max_loss_pct: maxLossPct,
        max_profit_pct: maxProfitPct,

        active_loss_floor: Number(st.active_loss_floor || 0),
        remaining_to_max_loss: Number(st.remaining_to_max_loss || 0),

        tripped: !!st.tripped,
        tripped_day: !!st.tripped_day,

        consecutive_losses: Number(st.consecutive_losses || 0),
        cooldown_active: !!st.cooldown_active,

        last_trade_time: Number(st.last_trade_time || 0),

        positions,
        funds
      }
    });

  } catch (err) {
    return NextResponse.json({
      ok: false,
      error: err.message
    });
  }
}
