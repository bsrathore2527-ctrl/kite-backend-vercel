// api/debug/sim-trade.js
// Admin-only simulator to emulate BUY / SELL events for testing the guardian/trades logic.
//
// Usage (curl examples below).
//
// SECURITY: requires ADMIN_TOKEN env var. Pass in Authorization: Bearer <ADMIN_TOKEN>.

import { updateState, getState } from "../_lib/state.js";
import { cancelPending, squareOffAll } from "../enforce.js";
import { instance } from "../_lib/kite.js";

function isAdmin(req) {
  const a = req.headers?.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function nowMs() { return Date.now(); }

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.setHeader("Allow", "POST");
      return res.status(405).json({ ok: false, error: "Method not allowed. Use POST." });
    }

    if (!isAdmin(req)) return res.status(403).json({ ok: false, error: "Forbidden. Missing/invalid admin token." });

    const body = req.body && typeof req.body === "object" ? req.body : {};
    const typ = String((body.type || "").toUpperCase() || "").trim(); // "SELL" or "BUY"
    if (!typ || (typ !== "SELL" && typ !== "BUY")) {
      return res.status(400).json({ ok: false, error: "Missing/invalid 'type'. Use 'SELL' or 'BUY'." });
    }

    // Accept mtm override; if not provided we'll read current positions from Kite
    let mtmOverride = typeof body.mtm === "number" ? Number(body.mtm) : null;
    const enforce = body.enforce === false ? false : true; // default true; set false to skip cancel/square
    const now = nowMs();

    // Resolve MTM: if provided by caller use it; otherwise sample from Kite positions
    let mtmNow = mtmOverride;
    if (mtmNow === null) {
      try {
        const kc = await instance();
        const pos = await kc.getPositions();
        const net = pos?.net || [];
        let total = 0;
        for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
        mtmNow = Number(total);
      } catch (e) {
        // fallback to 0 if kite not available
        mtmNow = 0;
      }
    }

    // Helper for enforcement (similar to markTrippedAndKillInternal)
    async function doEnforceAndPersist(reason, meta = {}) {
      // set tripped in state first (atomic)
      await updateState((s = {}) => {
        const now2 = Date.now();
        s.tripped_day = true;
        s.tripped_reason = reason;
        s.tripped_meta = { ...(s.tripped_meta || {}), ...meta, at: now2 };
        s.block_new_orders = true;
        s.last_enforced_at = now2;
        return s;
      });

      if (!enforce) {
        return { cancelled: [], squared: [] };
      }

      try {
        const kc = await instance();
        const cancelled = await cancelPending(kc);
        const squared = await squareOffAll(kc);
        await updateState(s => ({ ...(s || {}), admin_last_enforce_result: { cancelled, squared, at: Date.now() } }));
        return { cancelled, squared };
      } catch (e) {
        console.error("sim-trade enforce error:", e?.message || e);
        return { cancelled: [], squared: [], error: String(e) };
      }
    }

    // Simulate SELL logic (atomic update)
    if (typ === "SELL") {
      // Use updateState to do atomic read-modify-write
      const updated = await updateState((s = {}) => {
        const prevMtm = Number(s.last_mtm ?? 0);
        const realisedDelta = Number(mtmNow) - prevMtm;
        const isLoss = realisedDelta < 0;

        let consec = Number(s.consecutive_losses ?? 0);
        const windowMin = Number(s.consecutive_time_window_min ?? 60);
        const lastLossTs = Number(s.last_loss_ts ?? 0);
        const nowTs = Date.now();

        if (isLoss) {
          if (!lastLossTs || (nowTs - lastLossTs) > windowMin * 60 * 1000) {
            consec = 1;
          } else {
            consec = consec + 1;
          }
          s.last_loss_ts = nowTs;
          s.cooldown_until = nowTs + Number(s.cooldown_min ?? 15) * 60 * 1000;
        } else {
          consec = 0;
        }

        s.last_mtm = Number(mtmNow);
        s.last_mtm_ts = nowTs;

        s.last_realised_change = realisedDelta;
        s.last_realised_change_ts = nowTs;

        s.last_sell_ts = nowTs;
        s.consecutive_losses = consec;

        // keep other keys unchanged
        return s;
      });

      // decide if trip
      const maxConsec = Number(updated.max_consecutive_losses ?? 0);
      if (maxConsec > 0 && Number(updated.consecutive_losses ?? 0) >= maxConsec && !updated.tripped_day) {
        const enforcement = await doEnforceAndPersist("consecutive_losses_simulator", { simulated: true, mtm: mtmNow });
        return res.status(200).json({ ok: true, action: "SELL_simulated", updated, enforcement });
      }

      return res.status(200).json({ ok: true, action: "SELL_simulated", updated });
    }

    // Simulate BUY logic: check cooldown and optionally trip
    if (typ === "BUY") {
      // We'll read current state and check cooldown. We'll not mutate other fields unless trip occurs.
      const s = await getState();
      const cooldownUntil = Number(s.cooldown_until ?? 0);
      const nowTs = Date.now();

      if (!s.tripped_day && cooldownUntil && nowTs < cooldownUntil) {
        // Trip due to BUY during cooldown
        const enforcement = await doEnforceAndPersist("buy_during_cooldown_simulator", { simulated: true, cooldownUntil });
        const after = await getState();
        return res.status(200).json({ ok: true, action: "BUY_simulated_trip", before: s, after, enforcement });
      }

      // otherwise, a BUY during non-cooldown does not mutate state by this simulator
      return res.status(200).json({ ok: true, action: "BUY_simulated_noop", state: s });
    }

    // fallback (shouldn't happen)
    return res.status(400).json({ ok: false, error: "Unsupported simulation type" });
  } catch (err) {
    console.error("sim-trade error:", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: String(err) });
  }
}
