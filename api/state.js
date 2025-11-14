// api/state.js
// Return merged runtime "state" for admin UI.
// - Reads persisted risk state from KV (getState).
// - Augments with live kite info: kite_status, current_balance, realised/unrealised totals.
// - Computes active_loss_floor and remaining_to_max_loss using the rule:
//     max_loss_abs = round(capital_day_915 * (max_loss_pct/100))
//     active_loss_floor = realised - max_loss_abs
//     remaining_to_max_loss = (if total_pnl >= 0) max_loss_abs - total_pnl
//                             else max_loss_abs + total_pnl
//
// Records last_mtm and last_mtm_ts in returned state (last_mtm set either from persisted value
// or from latest total_pnl). For precise "last_mtm on SELL" behaviour, also see the recommended
// snippet for api/kite/trades.js below.

import { getState } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

function nowMs() { return Date.now(); }
function safeNum(v, fallback = 0) {
  if (v === null || v === undefined || v === "") return fallback;
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function formatIst(ms = Date.now()) {
  return new Date(ms).toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const persisted = (await getState()) || {};

    // Basic defaults
    let kite_status = "not_logged_in";
    let current_balance = safeNum(persisted.current_balance ?? persisted.live_balance ?? 0);
    let live_balance = safeNum(persisted.live_balance ?? persisted.current_balance ?? 0);
    let realised = safeNum(persisted.realised ?? 0);
    let unrealised = safeNum(persisted.unrealised ?? 0);
    // total_pnl derives from realised + unrealised
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

            // update only if kite returned meaningful numbers
            if (m2m_realised !== 0 || m2m_unrealised !== 0) {
              realised = m2m_realised;
              unrealised = m2m_unrealised;
              total_pnl = realised + unrealised;
            }
          } else {
            // fallback to positions if funds not available
            const pos = await (kc.getPositions?.() || kc.get_positions?.());
            if (pos) {
              const net = pos.net || [];
              let computedUnreal = 0;
              for (const p of net) {
                // handle varying field names
                const v = safeNum(p.pnl?.unrealised ?? p.unrealised_pnl ?? p.m2m_unrealised ?? p.m2m ?? 0);
                computedUnreal += v;
              }
              unrealised = computedUnreal;
              total_pnl = realised + unrealised;
            }
          }
        } catch (e) {
          console.warn("api/state: kite funds/positions fetch failed:", e && e.message ? e.message : e);
        }
      }
    } catch (e) {
      kite_status = "not_logged_in";
    }

    // Ensure numbers
    realised = safeNum(realised, 0);
    unrealised = safeNum(unrealised, 0);
    total_pnl = Number(realised + unrealised);

    // Capital and base loss (derive base loss absolute from capital * pct)
    const capital = safeNum(persisted.capital_day_915 ?? 0, 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0, 0);
    const base_loss_abs = Math.round(capital * (maxLossPct / 100));
    const max_loss_abs = base_loss_abs; // alias for compatibility

    // Active loss floor (moves with realised profit)
    const active_loss_floor = Math.round(realised - base_loss_abs);

    // NEW rule for remaining_to_max_loss:
    // - if total_pnl >= 0: remaining = max_loss_abs - total_pnl
    // - if total_pnl < 0: remaining = max_loss_abs + total_pnl (keep old behaviour)
    let remaining_to_max_loss;
    if (Number.isFinite(total_pnl) && total_pnl >= 0) {
      remaining_to_max_loss = Math.round(max_loss_abs - total_pnl);
      if (remaining_to_max_loss < 0) remaining_to_max_loss = 0; // safety floor
    } else {
      remaining_to_max_loss = Math.round(max_loss_abs + (Number.isFinite(total_pnl) ? total_pnl : 0));
    }

    // p10 (max profit lock) compute (unchanged)
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

    // Determine last_mtm / last_mtm_ts:
    // Prefer persisted last_mtm if present (so manual / trade-based updates remain authoritative).
    // Otherwise, set to the current snapshot total_pnl.
    const now = nowMs();
    const last_mtm = (typeof persisted.last_mtm !== "undefined" && persisted.last_mtm !== null)
      ? Number(persisted.last_mtm)
      : Number.isFinite(total_pnl) ? total_pnl : 0;
    const last_mtm_ts = (typeof persisted.last_mtm_ts !== "undefined" && persisted.last_mtm_ts !== null)
      ? Number(persisted.last_mtm_ts)
      : now;

    // Read additional SELL snapshot fields if present
    const last_sell_ts = (typeof persisted.last_sell_ts !== "undefined" && persisted.last_sell_ts !== null)
      ? Number(persisted.last_sell_ts)
      : (persisted.last_trade_time ? Number(persisted.last_trade_time) : 0);

    const last_realised_change = (typeof persisted.last_realised_change !== "undefined" && persisted.last_realised_change !== null)
      ? Number(persisted.last_realised_change)
      : 0;

    const last_realised_change_ts = (typeof persisted.last_realised_change_ts !== "undefined" && persisted.last_realised_change_ts !== null)
      ? Number(persisted.last_realised_change_ts)
      : null;

    // Prepare merged state to return
    const time_utc = new Date(now).toISOString();
    const time_ist = formatIst(now);

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
      // timestamps & MTM snapshot
      time_ms: now,
      time: time_ist,
      last_mtm,
      last_mtm_ts,
      // SELL snapshot fields exposed for UI/debug
      last_sell_ts,
      last_realised_change,
      last_realised_change_ts
    };

    res.setHeader("Cache-Control", "no-store").status(200).json({
      ok: true,
      time_utc,
      time_ist,
      time_ms: now,
      kite_status,
      state: mergedState
    });
  } catch (err) {
    console.error("api/state error:", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
