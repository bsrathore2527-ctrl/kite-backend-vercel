// /api/admin/test-enforce.js
// Testing module for enforce-trades without live market.
// Allows simulated MTM and day reset.

import enforceHandler from "../enforce-trades.js";
import { kv } from "../_lib/kv.js";

const STATE_KEY = "guardian:state";

export default async function handler(req, res) {
  try {
    const { test_mtm, reset_day } = req.query;

    // 1️⃣ RESET DAY MODE — clears tripped_day for testing again
    if (reset_day === "true") {
      const raw = await kv.get(STATE_KEY);
      const state = raw ? JSON.parse(raw) : {};

      state.tripped_day = false;
      state.trip_reason = null;
      state.block_new_orders = false;
      state.consecutive_losses = 0;
      state.cooldown_active = false;
      state.cooldown_until = 0;
      state.last_reset_by = "admin_test";
      state.last_reset_at = Date.now();

      await kv.set(STATE_KEY, JSON.stringify(state));

      return res.status(200).json({
        ok: true,
        reset: true,
        message: "Day reset successfully",
        state
      });
    }

    // 2️⃣ TEST MODE — simulate MTM and run enforce-trades
    if (typeof test_mtm !== "undefined") {
      req.query.test_mtm = test_mtm;  // inject test mtm
      console.log("TEST-ENFORCE: Simulating MTM =", test_mtm);
      return enforceHandler(req, res);
    }

    return res.status(400).json({
      ok: false,
      error: "Provide ?test_mtm or ?reset_day=true"
    });

  } catch (err) {
    console.error("test-enforce failed:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
