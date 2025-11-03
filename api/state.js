// api/state.js
// Return merged runtime "state" for admin UI.
// - Reads persisted risk state from KV (setState/getState).
// - Augments with live kite info: kite_status, current_balance, realised/unrealised totals.
// - Computes active_loss_floor and remaining_to_max_loss using the rule:
//     active_loss_floor = - (capital_day_915 * (max_loss_pct/100))
//     remaining_to_max_loss = max_loss_abs + total_pnl
//   which matches: if total_pnl is +189 and max loss is 10000 => remaining = 10000 + 189
//
// Note: timestamps are stored as epoch ms (UTC). Do NOT add timezone offsets here.

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
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // base persisted state
    const persisted = await getState();
    const out = {
      ok: true,
      time_ms: nowMs(),
      time: new Date(nowMs()).toLocaleTimeString(), // UI can choose to use time_ms instead
      admin: !!(persisted && persisted.admin),
      state: persisted || {}
    };

    // default derived values
    let kite_status = "not_logged_in";
    let current_balance = safeNum(persisted.current_balance || persisted.live_balance || 0);
    let live_balance = safeNum(persisted.live_balance || persisted.current_balance || 0);
    let realised = safeNum(persisted.realised || 0);
    let unrealised = safeNum(persisted.unrealised || 0);
    let total_pnl = Number(realised + unrealised);

    // Try to fetch live Kite funds/positions if kite instance available
    try {
      const kc = await instance();
      if (kc) {
        kite_status = "ok";
        // try getFunds
        try {
          const funds = await kc.getFunds?.(); // may not exist on older adapters
          if (funds) {
            // normalize a few common shapes
            // prefer funds.equity.available.live_balance OR funds.equity.available.opening_balance etc.
            const equity = funds.equity || funds;
            const available = equity.available || {};
            const utilised = equity.utilised || {};
            // current live balance preference
            const liveBalCandidate = safeNum(available.live_balance ?? available.liveBalance ?? available.opening_balance ?? available.openingBalance ?? 0);
            if (liveBalCandidate !== 0) {
              current_balance = liveBalCandidate;
              live_balance = liveBalCandidate;
            }
            // prefer m2m_realised / m2m_unrealised inside utilised or top-level equity keys
            const m2m_realised = safeNum(utilised.m2m_realised ?? equity.m2m_realised ?? 0);
            const m2m_unrealised = safeNum(utilised.m2m_unrealised ?? equity.m2m_unrealised ?? 0);
            if (m2m_realised !== 0 || m2m_unrealised !== 0) {
              realised = m2m_realised;
              unrealised = m2m_unrealised;
              total_pnl = realised + unrealised;
            }
          } else {
            // funds call absent — try positions
            const pos = await kc.getPositions?.();
            if (pos) {
              const net = pos.net || [];
              // compute unrealised as sum of common fields
              let computedUnreal = 0;
              for (const p of net) {
                const v = safeNum(p.pnl?.unrealised ?? p.pnl_unrealised ?? p.m2m_unrealised ?? p.m2m ?? 0);
                computedUnreal += v;
              }
              unrealised = computedUnreal;
              total_pnl = realised + unrealised;
            }
          }
        } catch (e) {
          // kite getFunds/positions failed; keep persisted values
          console.warn("api/state: kite funds/positions fetch failed:", e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      // instance() failed -> kite not logged in
      kite_status = "not_logged_in";
    }

    // Ensure numeric types
    realised = safeNum(realised, 0);
    unrealised = safeNum(unrealised, 0);
    total_pnl = Number(realised + unrealised);

    // Compute active loss floor & remaining to max loss using the rule we agreed:
    // maxLossPct from state, capital_day_915 from state.
    const capital = safeNum(persisted.capital_day_915 ?? 0, 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0, 0);
    const maxLossAbs = Math.round(capital * (maxLossPct / 100)); // e.g. 10000
    const active_loss_floor = -Math.abs(maxLossAbs); // e.g. -10000

    // Per your requested semantics:
    // remaining_to_max_loss = max_loss_abs + total_pnl
    // - if total_pnl is +189 and max_loss_abs 10000 => remaining = 10000 + 189
    // - if total_pnl is -189 => remaining = 10000 - 189
    const remaining_to_max_loss = Math.round(maxLossAbs + total_pnl);

    // Max profit lock (p10) handling: prefer p10_pct (percentage), else p10_amount/p10_amount field
    let max_profit_lock_amount = 0;
    if (typeof persisted.p10_is_pct !== "undefined" && persisted.p10_is_pct) {
      const p10pct = safeNum(persisted.p10 ?? persisted.p10_pct ?? 0, 0);
      max_profit_lock_amount = Math.round(capital * (p10pct / 100));
    } else {
      // accept p10_amount or p10
      max_profit_lock_amount = Math.round(safeNum(persisted.p10_amount ?? persisted.p10 ?? 0, 0));
    }

    // Build final response.state (merge persisted + computed values)
    const mergedState = {
      ...persisted,
      kite_status,
      current_balance,
      live_balance,
      realised,
      unrealised,
      total_pnl,
      active_loss_floor,
      remaining_to_max_loss,
      p10_effective_amount: max_profit_lock_amount,
      time: new Date(nowMs()).toISOString(),
      time_ms: nowMs()
    };

    // respond
    res.setHeader("Cache-Control", "no-store").status(200).json({
      ok: true,
      time: new Date().toLocaleTimeString(),
      time_ms: nowMs(),
      kite_status,
      state: mergedState
    });
  } catch (err) {
    console.error("api/state error:", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
