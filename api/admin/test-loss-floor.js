// api/admin/test-loss-floor.js
// Pure simulation of trailing max-loss floor logic.
// Does NOT modify any KV state.

import { getState } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const { mtm } = req.query;
    if (mtm === undefined) {
      return res.status(400).json({
        ok: false,
        error: "Provide ?mtm=<number> (hypothetical total_pnl)"
      });
    }

    const totalPnl = Number(mtm);
    if (!Number.isFinite(totalPnl)) {
      return res.status(400).json({ ok: false, error: "mtm must be a number" });
    }

    const state = await getState();

    // 1) Resolve max_loss_abs
    let maxLossAbs = Number(state.max_loss_abs ?? 0);
    if (!maxLossAbs || !Number.isFinite(maxLossAbs)) {
      const capital = Number(state.capital_day_915 ?? 0);
      const pct = Number(state.max_loss_pct ?? 0);
      if (capital > 0 && pct > 0) {
        maxLossAbs = Math.round(capital * (pct / 100));
      }
    }

    const trailStep = Number(state.trail_step_profit ?? 0);

    // 2) Read current floor and peak
    const currentFloorRaw =
      state.active_loss_floor ?? (maxLossAbs ? -maxLossAbs : 0);
    const currentFloor = Number.isFinite(Number(currentFloorRaw))
      ? Number(currentFloorRaw)
      : maxLossAbs
      ? -maxLossAbs
      : 0;

    const currentPeakRaw = state.peak_profit ?? 0;
    const currentPeak = Number.isFinite(Number(currentPeakRaw))
      ? Number(currentPeakRaw)
      : 0;

    // 3) Calculate next peak
    let nextPeak = currentPeak;
    if (totalPnl > currentPeak) nextPeak = totalPnl;

    // 4) Calculate trail_level (THIS IS THE VARIABLE THAT WAS CAUSING ERROR)
    let trail_level = 0;
    if (trailStep > 0 && nextPeak > 0) {
      trail_level = Math.floor(nextPeak / trailStep) * trailStep;
    }

    // 5) Compute new floor candidate
    let newFloorCandidate = maxLossAbs > 0 ? -maxLossAbs : currentFloor;
    if (trail_level > 0 && maxLossAbs > 0) {
      newFloorCandidate = trail_level - maxLossAbs;
    }

    // 6) Final floor (never moves down)
    let nextFloor = currentFloor;
    if (!Number.isFinite(nextFloor)) nextFloor = newFloorCandidate;
    if (newFloorCandidate > nextFloor) nextFloor = newFloorCandidate;

    // 7) Always remaining_to_max_loss = maxLossAbs
    const remaining = maxLossAbs;

    // 8) Would this MTM trip?
    const wouldTrip = maxLossAbs > 0 && totalPnl <= nextFloor;

    return res.status(200).json({
      ok: true,
      input_mtm: totalPnl,
      state_snapshot: {
        max_loss_abs: maxLossAbs,
        trail_step_profit: trailStep,
        current_floor: currentFloor,
        current_peak_profit: currentPeak
      },
      simulated: {
        next_peak_profit: nextPeak,
        trail_level: trail_level,
        new_floor_candidate: newFloorCandidate,
        next_floor: nextFloor,
        remaining_to_max_loss: remaining,
        would_trip_max_loss_floor: wouldTrip
      }
    });
  } catch (err) {
    console.error("TEST-LOSS-FLOOR ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error in test-loss-floor"
    });
  }
}
