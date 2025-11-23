// api/state.js
// Return merged runtime "state" for admin UI.
// - Reads persisted risk state from KV (getState).
// - Augments with live kite info: kite_status, current_balance, realised/unrealised totals.
// - Computes active_loss_floor and remaining_to_max_loss using the rule:
//     max_loss_abs = round(capital_day_915 * (max_loss_pct/100))
//     active_loss_floor = -max_loss_abs
//     remaining_to_max_loss = max_loss_abs + total_pnl
//
// Max profit lock (p10) is computed similarly (percentage of capital) unless explicit p10_amount provided.
//
// Timestamps are stored as epoch ms (UTC). UI should display local times using time_ms.

import { getState } from "./_lib/kv.js";
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
    const persisted = await getState() || {};

    // Basic defaults
    let kite_status = "not_logged_in";
    let current_balance = safeNum(persisted.current_balance ?? persisted.live_balance ?? 0);
    let live_balance = safeNum(persisted.live_balance ?? persisted.current_balance ?? 0);
    let realised = safeNum(persisted.realised ?? 0);
    let unrealised = safeNum(persisted.unrealised ?? 0);
    let total_pnl = Number(realised + unrealised);

    // Try to fetch live kite info (best-effort)
    try {
      const kc = await instance();
      if (kc) {
        kite_status = "ok";

        // Try funds first (preferred)
        try {
          const funds = await (kc.getFunds?.() || kc.get_funds?.());
          if (funds) {
            const equity = funds.equity || funds;
            const available = equity.available || {};
            const utilised = equity.utilised || equity.utilization || {};

            const liveBalCandidate = safeNum(
              available.live_balance ??
              available.liveBalance ??
              available.opening_balance ??
              available.openingBalance ??
              0
            );

            if (liveBalCandidate !== 0) {
              current_balance = liveBalCandidate;
              live_balance = liveBalCandidate;
            }

            const m2m_realised = safeNum(utilised.m2m_realised ?? equity.m2m_realised ?? 0);
            const m2m_unrealised = safeNum(utilised.m2m_unrealised ?? equity.m2m_unrealised ?? 0);

            if (m2m_realised !== 0 || m2m_unrealised !== 0) {
              realised = m2m_realised;
              unrealised = m2m_unrealised;
              total_pnl = realised + unrealised;
            }
          } else {
            const pos = await (kc.getPositions?.() || kc.get_positions?.());
            if (pos) {
              const net = pos.net || [];
              let computedUnreal = 0;
              for (const p of net) {
                const v = safeNum(p.pnl?.unrealised ?? p.unrealised_pnl ?? p.m2m_unrealised ?? p.m2m ?? 0);
                computedUnreal += v;
              }
              unrealised = computedUnreal;
              total_pnl = realised + unrealised;
            }
          }
        } catch (e) {
          console.warn("api/state: kite funds/positions fetch failed:", e?.message || e);
        }
      }
    } catch (e) {
      kite_status = "not_logged_in";
    }

    realised = safeNum(realised, 0);
    unrealised = safeNum(unrealised, 0);
    total_pnl = Number(realised + unrealised);

    // Capital and base loss
    const capital = safeNum(persisted.capital_day_915 ?? 0, 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0, 0);
    const base_loss_abs = Math.round(capital * (maxLossPct / 100));
    const max_loss_abs = base_loss_abs;

    const active_loss_floor = Math.round(realised - base_loss_abs);
    const remaining_to_max_loss = Math.round(total_pnl - active_loss_floor);

    let p10_effective_amount = 0;
    const explicitAmount = safeNum(persisted.p10_amount ?? persisted.p10_amount_rupee ?? 0, 0);
    if (explicitAmount > 0) {
      p10_effective_amount = Math.round(explicitAmount);
    } else {
      const p10pct = safeNum(persisted.p10_pct ?? persisted.p10 ?? 0, 0);
      if (p10pct > 0) {
        p10_effective_amount = Math.round(capital * (p10pct / 100));
      } else {
        p10_effective_amount = 0;
      }
    }

    // ⭐ FINAL MERGED STATE
    const mergedState = {
      ...persisted,
      kite_status,
      current_balance,
      live_balance,
      realised,
      unrealised,
      total_pnl,
      capital_day_915: capital,
      max_loss_pct: maxLossPct,
      max_loss_abs,
      active_loss_floor,
      remaining_to_max_loss,
      p10_effective_amount,

      // ⭐ ADDED FIX — now shows in UI & system
      consecutive_losses: persisted.consecutive_losses ?? 0,

      time_ms: nowMs(),
      time: new Date(nowMs()).toISOString()
    };

    res.setHeader("Cache-Control", "no-store").status(200).json({
      ok: true,
      time: new Date().toLocaleTimeString(),
      time_ms: nowMs(),
      kite_status,
      state: mergedState
    });

  } catch (err) {
    console.error("api/state error:", err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
