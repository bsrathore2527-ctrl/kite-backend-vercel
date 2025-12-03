// api/state.js (patched: NO PNL override from Kite)
// --------------------------------------------------

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
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const persisted = (await getState()) || {};

    // ---- P&L strictly from mtm-worker ----
    let realised = safeNum(persisted.realised ?? 0);
    let unrealised = safeNum(persisted.unrealised ?? 0);
    let total_pnl = realised + unrealised;

    // ---- balances (from KV, but can update from kite funds) ----
    let current_balance = safeNum(persisted.current_balance ?? persisted.live_balance ?? 0);
    let live_balance = safeNum(persisted.live_balance ?? persisted.current_balance ?? 0);

    let kite_status = persisted.kite_status ?? "not_logged_in";

    // Try to update ONLY balance info from Kite
    try {
      const kc = await instance();
      if (kc) {
        kite_status = "ok";

        try {
          const funds = await (kc.getFunds?.() || kc.get_funds?.());
          if (funds) {
            const equity = funds.equity || funds;
            const available = equity.available || {};

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
          }
        } catch (e) {
          console.warn("state: kite funds fetch failed:", e.message || e);
        }
      }
    } catch {
      // kite not logged in, ignore
    }

    // ---- Risk logic (unchanged) ----
    const capital = safeNum(persisted.capital_day_915 ?? 0);
    const maxLossPct = safeNum(persisted.max_loss_pct ?? 0);
    const max_loss_abs = Math.round(capital * (maxLossPct / 100));

    const active_loss_floor = Number.isFinite(persisted.active_loss_floor)
      ? Number(persisted.active_loss_floor)
      : -max_loss_abs;

    const remaining_to_max_loss = Number.isFinite(persisted.remaining_to_max_loss)
      ? Number(persisted.remaining_to_max_loss)
      : max_loss_abs;

    // profit lock p10 logic unchanged
    let p10_effective_amount = 0;
    const explicitAmount = safeNum(persisted.p10_amount ?? persisted.p10_amount_rupee ?? 0);
    if (explicitAmount > 0) {
      p10_effective_amount = Math.round(explicitAmount);
    } else {
      const p10pct = safeNum(persisted.p10_pct ?? persisted.p10 ?? 0);
      if (p10pct > 0) {
        p10_effective_amount = Math.round(capital * (p10pct / 100));
      }
    }

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
      consecutive_losses: persisted.consecutive_losses ?? 0,
      time_ms: nowMs(),
      time: new Date().toISOString()
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
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
