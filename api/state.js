// api/state.js
// Safely enhanced to fix live_balance, PnL, max loss/profit, and time logic.
// Fixed: remaining_to_max_loss now uses (maxLossRupees - total_pnl) so negative pnl increases room.

import { kv, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function getISTTime() {
  return new Date().toLocaleTimeString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
  });
}

async function getKiteFunds() {
  try {
    const kc = await instance();
    if (!kc) return { kite_status: "not_logged_in" };

    // try to detect login by checking profile or account
    try {
      const profile = await kc.getProfile?.();
      if (!profile?.user_id) return { kite_status: "not_logged_in" };
    } catch (e) {
      // if getProfile fails, still try funds
    }

    const funds = await kc.getFunds?.();
    return { kite_status: "ok", funds };
  } catch (err) {
    console.warn("api/state: getKiteFunds() error", err?.message || err);
    return { kite_status: "not_logged_in" };
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  const now = Date.now();
  const timeStr = getISTTime();

  try {
    const key = `risk:${todayKey()}`;
    const s = (await kv.get(key)) || {};

    // fetch kite funds and status
    const { kite_status, funds } = await getKiteFunds();

    // extract values (fall back to stored state if kite not available)
    let live_balance = safeNum(s.live_balance);
    let realised = safeNum(s.realised);
    let unrealised = safeNum(s.unrealised);

    if (funds && funds.funds) {
      const f = funds.funds;
      // prefer explicit live_balance from Kite response if present
      if (f.available && typeof f.available.live_balance !== "undefined") {
        live_balance = safeNum(f.available.live_balance);
      } else if (typeof f.net !== "undefined") {
        live_balance = safeNum(f.net);
      }

      // use Kite m2m fields if available
      if (f.utilised && typeof f.utilised.m2m_realised !== "undefined") {
        realised = safeNum(f.utilised.m2m_realised);
      }
      if (f.utilised && typeof f.utilised.m2m_unrealised !== "undefined") {
        unrealised = safeNum(f.utilised.m2m_unrealised);
      }
    }

    // Derived values
    const total_pnl = realised + unrealised;
    const capital = safeNum(s.capital_day_915);
    const maxLossPct = safeNum(s.max_loss_pct);
    const maxLossRupees = Math.round((capital * maxLossPct) / 100);

    // active loss floor is negative
    const active_loss_floor = -Math.abs(maxLossRupees);

    // IMPORTANT fix: use total_pnl (signed). If total_pnl is negative, subtracting a negative increases remaining
    const remaining_to_max_loss = Math.round(maxLossRupees - total_pnl);

    // resolve p10 (max profit lock) as rupee value
    let p10_rupee = 0;
    if (s.p10_is_pct) {
      const pct = safeNum(s.p10 ?? s.p10_amount ?? 0);
      p10_rupee = Math.round((capital * pct) / 100);
    } else {
      p10_rupee = safeNum(s.p10_amount ?? s.p10 ?? 0);
    }

    const state = {
      ...s,
      realised,
      unrealised,
      total_pnl,
      current_balance: live_balance,
      live_balance,
      remaining_to_max_loss,
      active_loss_floor,
      p10_resolved: p10_rupee,
      kite_status,
      time: timeStr,
      time_ms: now,
    };

    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({
      ok: true,
      time: timeStr,
      time_ms: now,
      admin: false,
      kite_status,
      state,
    });
  } catch (err) {
    console.error("api/state fatal:", err && (err.stack || err));
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
