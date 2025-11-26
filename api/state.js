// api/state.js
// Central risk / overview state endpoint.
// - Reads today's persisted state from KV (getState)
// - Overlays live MTM from KV key "live:mtm" (written by positions-mtm / poller)
// - Computes derived totals and returns { ok, time, kite_status, state: { ... } }
//   exactly as admin.html / admin_js expect.

import { kv, getState, setState } from "./_lib/kv.js";

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

function istNow() {
  return new Date().toLocaleString("en-IN", {
    timeZone: "Asia/Kolkata",
    hour12: false
  });
}

export default async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    // 1) Base persisted state for today (risk:YYYY-MM-DD)
    const base = await getState() || {};

    // 2) Live MTM from KV (positions-mtm / poller writes here)
    let liveMTM = null;
    try {
      const mtmObj = await kv.get("live:mtm");
      if (mtmObj && typeof mtmObj === "object") {
        const candidates = [
          mtmObj.total,
          mtmObj.unrealised,
          mtmObj.unrealized,
          mtmObj.mtm
        ];
        for (const c of candidates) {
          const n = Number(c);
          if (Number.isFinite(n)) {
            liveMTM = n;
            break;
          }
        }
      }
    } catch (e) {
      // ignore, will fall back to persisted unrealised
      console.error("state.js: failed to read live:mtm from KV:", e && e.message ? e.message : e);
    }

    // 3) Core numbers
    const capital = safeNum(base.capital_day_915 ?? base.capital, 0);
    const realised = safeNum(base.realised, 0);
    const unrealised = liveMTM !== null
      ? safeNum(liveMTM, 0)
      : safeNum(base.unrealised, 0);

    const total_pnl = realised + unrealised;

    // 4) Max loss absolute (₹) from either stored or % * capital
    const maxLossPct = safeNum(base.max_loss_pct, 0);
    let max_loss_abs = safeNum(base.max_loss_abs, 0);
    if (!max_loss_abs && capital > 0 && maxLossPct > 0) {
      max_loss_abs = Math.round(capital * (maxLossPct / 100));
    }

    // 5) Remaining to max loss (if not already maintained by enforce-trades)
    let remaining_to_max_loss = base.remaining_to_max_loss;
    if (!Number.isFinite(Number(remaining_to_max_loss))) {
      // If trailing active_loss_floor present, use that as floor; else use -max_loss_abs
      const floorRaw =
        base.active_loss_floor ??
        (max_loss_abs ? -max_loss_abs : 0);
      const floor = safeNum(floorRaw, 0);
      remaining_to_max_loss = floor - total_pnl;
    } else {
      remaining_to_max_loss = safeNum(remaining_to_max_loss, 0);
    }

    // 6) Compose next state object
    const nextState = {
      // everything that was already stored
      ...base,

      // normalized / derived fields we want to be consistent
      capital_day_915: capital,
      realised,
      unrealised,
      total_pnl,
      max_loss_abs,
      remaining_to_max_loss
    };

    // 7) Persist back the important derived fields so other modules (enforce-trades, sellbook) see same total_pnl
    try {
      await setState({
        realised,
        unrealised,
        total_pnl,
        max_loss_abs,
        remaining_to_max_loss
      });
    } catch (e) {
      console.error("state.js: setState merge failed:", e && e.message ? e.message : e);
    }

    // 8) Admin flag (just for UI label; real security is on /api/admin/*)
    const hasAuth = !!req.headers["authorization"];
    const admin = !!hasAuth;

    // 9) Kite status (as written by enforce-trades or login)
    const kite_status = nextState.kite_status || "unknown";

    return res.status(200).json({
      ok: true,
      time_ms: Date.now(),
      time: istNow(),
      admin,
      kite_status,
      state: nextState
    });

  } catch (err) {
    console.error("state.js error:", err);
    return res
      .status(500)
      .json({ ok: false, error: err && err.message ? err.message : String(err) });
  }
}
