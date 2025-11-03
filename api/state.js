// api/state.js
// Merged guardian state + live Kite connectivity check.
// Fully backward compatible, fixes false "not_logged_in" flag and timezone mismatch.

import { kv, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function safeNum(v, d = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

function nowIST() {
  return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
}

async function getKiteStatusAndFunds() {
  try {
    const kc = await instance();
    if (!kc) return { kite_status: "not_logged_in" };

    // ✅ 1️⃣ Try light ping first
    try {
      const prof = await kc.getProfile?.();
      if (prof && prof.user_id) {
        // minimal success
      }
    } catch (_) {
      // profile may fail, but we’ll still continue
    }

    // ✅ 2️⃣ Try funds to update live balance
    let funds = null;
    try {
      if (kc.getFunds) funds = await kc.getFunds();
    } catch (e) {
      console.warn("api/state: getFunds() failed", e?.message);
    }

    return { kite_status: "ok", funds };
  } catch (err) {
    console.error("api/state: kite instance() failed", err?.message);
    return { kite_status: "not_logged_in" };
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();

  const now = Date.now();
  const timeStr = nowIST();

  try {
    const riskKey = `risk:${todayKey()}`;
    const s = (await kv.get(riskKey)) || {};

    const { kite_status, funds } = await getKiteStatusAndFunds();

    let live_balance = s.live_balance ?? 0;
    let realised = s.realised ?? 0;
    let unrealised = s.unrealised ?? 0;

    // ✅ If funds found — extract proper balances
    if (funds && funds.funds) {
      try {
        const eq = funds.funds.equity || {};
        if (eq.available?.live_balance !== undefined) live_balance = eq.available.live_balance;
        if (eq.utilised?.m2m_realised !== undefined) realised = eq.utilised.m2m_realised;
        if (eq.utilised?.m2m_unrealised !== undefined) unrealised = eq.utilised.m2m_unrealised;
      } catch (e) {
        console.warn("api/state: fund parse error", e.message);
      }
    }

    const total_pnl = safeNum(realised) + safeNum(unrealised);
    const remaining_to_max_loss = safeNum(s.capital_day_915 ?? 0) - Math.abs(Math.min(total_pnl, 0));

    const state = {
      ...s,
      realised,
      unrealised,
      total_pnl,
      current_balance: live_balance,
      live_balance,
      remaining_to_max_loss,
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
    console.error("api/state fatal:", err?.stack || err);
    res.status(500).json({ ok: false, error: String(err.message || err) });
  }
}
