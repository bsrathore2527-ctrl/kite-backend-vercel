// api/admin/view-loss-floor.js
// Lightweight endpoint to view current loss-floor, peak-profit, and related fields.

import { getState } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const s = await getState();
    return res.status(200).json({
      ok: true,
      active_loss_floor: s.active_loss_floor ?? null,
      peak_profit: s.peak_profit ?? 0,
      remaining_to_max_loss: s.remaining_to_max_loss ?? null,
      max_loss_abs: s.max_loss_abs ?? null,
      trail_step_profit: s.trail_step_profit ?? null,
      consecutive_losses: s.consecutive_losses ?? 0,
      tripped_day: s.tripped_day ?? false,
      trip_reason: s.trip_reason ?? null,
      last_updated: new Date().toISOString()
    });
  } catch (err) {
    console.error("VIEW-LOSS-FLOOR ERROR:", err);
    return res.status(500).json({ ok: false, error: "Unable to fetch loss floor state" });
  }
}
