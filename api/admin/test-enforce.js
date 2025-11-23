// api/admin/test-enforce.js
// Full enforcement test using simulated MTM, with detailed before/after logs.
// Calls enforce-trades.js exactly as QStash would.

import enforceTrades from "../enforce-trades.js";
import { getState } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    req.query = req.query || {};

    if (!req.query.test_mtm && !req.query.reset_day) {
      return res.status(400).json({
        ok: false,
        error: "Provide ?test_mtm=<number> or ?reset_day=true",
      });
    }

    // Snapshot BEFORE state
    const beforeState = await getState();

    console.log("=== TEST-ENFORCE BEFORE STATE ===");
    console.log(JSON.stringify(beforeState, null, 2));

    // Run the actual enforcement logic
    const originalJson = res.json;
    let capturedResponse;

    // Intercept res.json to capture enforce-trades response
    res.json = (data) => {
      capturedResponse = data;
      return originalJson.call(res, data);
    };

    await enforceTrades(req, res);

    // Snapshot AFTER state
    const afterState = await getState();

    console.log("=== TEST-ENFORCE AFTER STATE ===");
    console.log(JSON.stringify(afterState, null, 2));

    // Generate diff
    const diff = {};
    for (const key of Object.keys(afterState)) {
      if (JSON.stringify(beforeState[key]) !== JSON.stringify(afterState[key])) {
        diff[key] = {
          before: beforeState[key],
          after: afterState[key],
        };
      }
    }

    console.log("=== TEST-ENFORCE DIFF ===");
    console.log(JSON.stringify(diff, null, 2));

    // Final output with full logs
    return originalJson.call(res, {
      ok: true,
      input_mtm: req.query.test_mtm,
      internal_response: capturedResponse,
      before: beforeState,
      after: afterState,
      diff,
    });

  } catch (err) {
    console.error("TEST-ENFORCE ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal error in test-enforce",
      stack: err?.stack,
    });
  }
}
