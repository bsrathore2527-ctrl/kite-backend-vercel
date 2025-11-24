// api/state.js (FULLY OPTIMIZED - USE KV MTM ONLY)
//
// This version eliminates all Zerodha MTM calculation
// and reads realised/unrealised/total_pnl ONLY from KV ("live:mtm")
// written by enforce-trades.js. This removes ALL lag.
//
// Zerodha API is used ONLY for fetching live_balance as a convenience,
// NOT for PnL or MTM.
//
// --------------------------------------------------------------

import { getState, kv } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function nowMs() { return Date.now(); }
function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // ---------------------------------------------------------------------
    // 1) LOAD PERSISTED DAILY STATE
    // ---------------------------------------------------------------------
    const persisted = (await getState()) || {};

    // ---------------------------------------------------------------------
    // 2) LOAD MTM FROM KV (PRIMARY SOURCE OF TRUTH)
    // ---------------------------------------------------------------------
    const live = await kv.get("live:mtm");

    let realised = safeNum(live?.realised ?? persisted.realised ?? 0);
    let unrealised = safeNum(live?.unrealised ?? persisted.unrealised ?? 0);
    let total_pnl = realised + unrealised;

    // ---------------------------------------------------------------------
    // 3) LIVE BALANCE (OPTIONAL ZERODHA CALL - DOES NOT IMPACT MTM)
    // ---------------------------------------------------------------------
    let live_balance = safeNum(persisted.live_balance ?? persisted.current_balance ?? 0);
    let current_balance = live_balance;
    let kite_status = persisted.kite_status ?? "not_logged_in";

    try {
      const kc = await instance();
      if (kc) {
        kite_status = "ok";

        // Fetch only balance-related info (NOT MTM!)
        try {
          const funds = await (kc.getFunds?.() || kc.get_funds?.());
          if (funds) {
            const eq = funds.equity || funds;
            const avail = eq.available || {};

            const bal = safeNum(
              avail.live_balance ??
              avail.liveBalance ??
              avail.opening_balance ??
              avail.openingBalance ??
              0
            );

            if (bal !== 0) {
              live_balance = bal;
              current_balance = bal;
            }
          }
        } catch (e) {
          console.warn("state.js: balance fallback error:", e?.message || e);
        }
      }
    } catch (e) {
      // instance or login not available; keep persisted balance
    }

    // ---------------------------------------------------------------------
    // 4) RISK CALCULATIONS
    // ---------------------------------------------------------------------
    realised = safeNum(realised);
    unrealised = safeNum(unrealised);
    total_pnl = realised + unrealised;

    const capital = safeNum(persisted.capital_day_915 ?? 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0);
    const max_loss_abs = Math.round(capital * (maxLossPct / 100));

    // If enforce-trades stored an adjusted floor, use it; else base floor
    const active_loss_floor = Number.isFinite(persisted.active_loss_floor)
      ? Number(persisted.active_loss_floor)
      : -max_loss_abs;

    // remaining_to_max_loss already maintained by enforce-trades
    const remaining_to_max_loss = Number.isFinite(persisted.remaining_to_max_loss)
      ? Number(persisted.remaining_to_max_loss)
      : max_loss_abs;

    // p10 calculation
    let p10_effective_amount = 0;
    const explicitRupee = safeNum(persisted.p10_amount ?? persisted.p10_amount_rupee ?? 0);
    if (explicitRupee > 0) {
      p10_effective_amount = Math.round(explicitRupee);
    } else {
      const p10pct = safeNum(persisted.p10_pct ?? persisted.p10 ?? 0);
      if (p10pct > 0) {
        p10_effective_amount = Math.round(capital * (p10pct / 100));
      }
    }

    // ---------------------------------------------------------------------
    // 5) MERGE & RETURN FINAL STATE
    // ---------------------------------------------------------------------
    const mergedState = {
      ...persisted,

      // LIVE MTM (KV driven)
      realised,
      unrealised,
      total_pnl,

      // BALANCE
      current_balance,
      live_balance,

      // LOSS LOGIC
      capital_day_915: capital,
      max_loss_pct: maxLossPct,
      max_loss_abs,
      active_loss_floor,
      remaining_to_max_loss,

      // p10 Lock
      p10_effective_amount,

      // Other fields
      consecutive_losses: persisted.consecutive_losses ?? 0,
      kite_status,

      // Timestamps
      time_ms: nowMs(),
      time: new Date().toISOString(),
      mtm_polled_at: live?.polled_at ?? null
    };

    return res
      .setHeader("Cache-Control", "no-store")
      .status(200)
      .json({
        ok: true,
        kite_status,
        time_ms: mergedState.time_ms,
        state: mergedState,
      });

  } catch (err) {
    console.error("state.js error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
