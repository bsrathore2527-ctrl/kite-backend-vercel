// api/state.js
// Returns merged guardian state + kite funds + computed PnL summary.
// - Prefers live values from Kite when available.
// - Ensures timestamps are epoch ms (Date.now()) to avoid timezone offset issues.

import { kv, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function safeNum(v, d = 0) {
  if (v === undefined || v === null || v === "") return d;
  const n = Number(v);
  return Number.isFinite(n) ? n : d;
}

// format local time in IST hh:mm:ss (24h)
function nowISTString() {
  try {
    return new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  } catch (e) {
    return new Date().toLocaleTimeString();
  }
}

async function fetchKiteFunds() {
  try {
    const kc = await instance();
    // kc.getFunds() or getFunds depending on client lib - try both
    const fn = kc.getFunds ? kc.getFunds.bind(kc) : (kc.funds ? (() => kc.funds) : null);
    if (fn) {
      const funds = await fn();
      return funds || null;
    }
    return null;
  } catch (e) {
    // Kite may not be logged in
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const time_ms = Date.now();
    const time = nowISTString();

    // read today's risk record from KV (if present)
    const riskKey = `risk:${todayKey()}`;
    const raw = await kv.get(riskKey);
    const risk = (raw && typeof raw === "object") ? raw : {};

    // start building the exposed state object (based on older behaviour)
    const state = Object.assign({}, risk);

    // ensure numeric fields exist with sane defaults
    state.capital_day_915 = safeNum(state.capital_day_915, 0);
    state.max_loss_pct = safeNum(state.max_loss_pct, 10);
    state.trail_step_profit = safeNum(state.trail_step_profit, 0);
    state.cooldown_min = safeNum(state.cooldown_min, 15);
    state.max_consecutive_losses = safeNum(state.max_consecutive_losses, 3);
    state.consecutive_losses = safeNum(state.consecutive_losses, 0);

    // Try to get live Kite funds to populate balances and m2m fields
    let kiteFunds = null;
    let kite_status = "not_logged_in";
    try {
      kiteFunds = await fetchKiteFunds();
      if (kiteFunds) kite_status = "ok";
    } catch (e) {
      kite_status = "error";
    }

    // compute live balance candidates (many kite responses differ across libs / versions)
    let live_balance = null;
    let balance_candidate = null;
    let m2m_realised = null;
    let m2m_unrealised = null;
    // Typical paths:
    // kiteFunds.funds.available.live_balance
    // kiteFunds.funds.net
    // kiteFunds.balance
    // kiteFunds.equity.available.live_balance (in some responses)
    if (kiteFunds) {
      try {
        // nested safe access
        const f = kiteFunds.funds || kiteFunds;
        if (f && f.available && typeof f.available.live_balance !== "undefined") {
          live_balance = safeNum(f.available.live_balance, null);
        } else if (f && typeof f.net !== "undefined") {
          live_balance = safeNum(f.net, null);
        } else if (typeof kiteFunds.balance !== "undefined") {
          live_balance = safeNum(kiteFunds.balance, null);
        } else if (kiteFunds.equity && kiteFunds.equity.available && typeof kiteFunds.equity.available.live_balance !== "undefined") {
          live_balance = safeNum(kiteFunds.equity.available.live_balance, null);
        }

        // m2m fields: check common places used by Kite
        if (f && f.utilised && typeof f.utilised.m2m_realised !== "undefined") {
          m2m_realised = safeNum(f.utilised.m2m_realised, 0);
        } else if (kiteFunds.utilised && typeof kiteFunds.utilised.m2m_realised !== "undefined") {
          m2m_realised = safeNum(kiteFunds.utilised.m2m_realised, 0);
        } else if (kiteFunds.m2m_realised !== undefined) {
          m2m_realised = safeNum(kiteFunds.m2m_realised, 0);
        }

        if (f && f.utilised && typeof f.utilised.m2m_unrealised !== "undefined") {
          m2m_unrealised = safeNum(f.utilised.m2m_unrealised, 0);
        } else if (kiteFunds.utilised && typeof kiteFunds.utilised.m2m_unrealised !== "undefined") {
          m2m_unrealised = safeNum(kiteFunds.utilised.m2m_unrealised, 0);
        } else if (kiteFunds.m2m_unrealised !== undefined) {
          m2m_unrealised = safeNum(kiteFunds.m2m_unrealised, 0);
        }

        // some APIs return funds.available.cash/net under equity/commodity
        if (live_balance === null && kiteFunds.equity && kiteFunds.equity.available && typeof kiteFunds.equity.available.live_balance !== "undefined") {
          live_balance = safeNum(kiteFunds.equity.available.live_balance, null);
        }

      } catch (e) {
        // ignore parsing errors - keep nulls
      }
    }

    // Use stored state values as fallback if kite didn't return m2m values
    const realised_from_state = safeNum(state.realised ?? 0, 0);
    const unreal_from_state = safeNum(state.unrealised ?? 0, 0);

    // Prefer kite m2m fields if available
    const realised = (m2m_realised !== null) ? m2m_realised : realised_from_state;
    const unrealised = (m2m_unrealised !== null) ? m2m_unrealised : unreal_from_state;

    // If live_balance available use it, else fallback to stored fields (current_balance, live_balance)
    const current_balance = (live_balance !== null) ? live_balance : safeNum(state.current_balance ?? state.live_balance ?? 0, 0);

    // compute total PnL (realised + unrealised)
    const total_pnl = realised + unrealised;

    // remaining to max loss: capital - abs(total) if total negative
    const remaining_to_max_loss = (() => {
      try {
        const capital = safeNum(state.capital_day_915, 0);
        // If total_pnl negative, we count loss; otherwise remaining is full capital minus zero
        const loss = total_pnl < 0 ? Math.abs(total_pnl) : 0;
        return capital - loss;
      } catch (e) {
        return safeNum(state.capital_day_915, 0);
      }
    })();

    // Expose a normalized `state` object (merge the stored risk + computed fields)
    const exposed = Object.assign({}, state, {
      // computed/normalized fields
      current_balance,
      live_balance: current_balance,
      realised,
      unrealised: unrealised,
      total_pnl,
      remaining_to_max_loss,
      // kite status
      kite_status,
      // time fields (IST string + epoch ms)
      time,
      time_ms
    });

    // Respond (no mutation) — UI will read these keys
    res.setHeader("Cache-Control", "no-store").status(200).json({
      ok: true,
      time,
      time_ms,
      admin: !!exposed.admin,
      kite_status,
      state: exposed
    });
  } catch (err) {
    console.error("api/state error:", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
