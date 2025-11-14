#!/usr/bin/env node
/**
 * test-integration.mjs
 *
 * Integration test for:
 *  - GET /api/state
 *  - GET /api/guardian
 *  - GET /api/kite/trades
 *
 * The script:
 * 1) reads /api/state and prints mtm & sell snapshot fields
 * 2) calls /api/guardian to trigger a refresh
 * 3) rereads /api/state to show updated fields
 * 4) fetches /api/kite/trades and prints latest trade
 *
 * Usage:
 *   node test-integration.mjs
 * or:
 *   BASE_URL="https://your-deploy" ADMIN_TOKEN="BearerTokenIfAny" node test-integration.mjs
 */

const BASE = process.env.BASE_URL?.replace(/\/$/, "") || "http://localhost:3000";
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || process.env.ADMIN_TOKEN_BEARER || null;
const TIMEOUT = 20000;

function pad(s) {
  return String(s).padEnd(30, " ");
}

async function call(path, opts = {}) {
  const url = BASE + path;
  const headers = opts.headers || {};
  if (ADMIN_TOKEN && !headers.Authorization) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  try {
    const res = await fetch(url, { method: opts.method || "GET", headers, signal: (opts.signal || undefined) });
    const text = await res.text();
    let body;
    try { body = JSON.parse(text); } catch (e) { body = text; }
    return { ok: res.ok, status: res.status, body };
  } catch (e) {
    return { ok: false, status: 0, error: e.message || String(e) };
  }
}

function fmtTs(ms) {
  if (!ms) return "(none)";
  try {
    const d = new Date(Number(ms));
    return d.toLocaleString("en-IN", { timeZone: "Asia/Kolkata", hour12: false });
  } catch (e) {
    return String(ms);
  }
}

async function printStateSnapshot(prefix, stateObj) {
  if (!stateObj) {
    console.log(prefix, "no state");
    return;
  }
  const s = stateObj;
  const last_mtm = s.last_mtm ?? s.total_pnl ?? "n/a";
  const last_mtm_ts = s.last_mtm_ts ?? s.time_ms ?? 0;
  const last_sell_ts = s.last_sell_ts ?? 0;
  const last_realised_change = s.last_realised_change ?? 0;
  console.log("\n" + prefix);
  console.log("  " + pad("last_mtm:"), last_mtm);
  console.log("  " + pad("last_mtm_ts:"), last_mtm_ts, "->", fmtTs(last_mtm_ts));
  console.log("  " + pad("last_sell_ts:"), last_sell_ts, "->", fmtTs(last_sell_ts));
  console.log("  " + pad("last_realised_change:"), last_realised_change);
  console.log("  " + pad("consecutive_losses:"), s.consecutive_losses ?? "n/a");
  console.log("  " + pad("cooldown_until:"), s.cooldown_until ?? 0, "->", fmtTs(s.cooldown_until ?? 0));
  console.log("  " + pad("total_pnl / realised / unrealised:"), `${s.total_pnl ?? "n/a"} / ${s.realised ?? "n/a"} / ${s.unrealised ?? "n/a"}`);
}

async function runIntegration() {
  console.log("BASE:", BASE);
  console.log("ADMIN_TOKEN set:", !!ADMIN_TOKEN);

  console.log("\n1) Fetching /api/state (before)");
  const st1 = await call("/api/state");
  if (!st1.ok) {
    console.warn("Could not fetch /api/state:", st1.error || st1.status, st1.body);
    console.warn("Falling back to local unit test (in-memory).");
    return runFallbackUnitTest();
  }
  const stateResp1 = st1.body && st1.body.state ? st1.body.state : (st1.body || {});
  await printStateSnapshot("STATE BEFORE REFRESH:", stateResp1);

  console.log("\n2) Calling /api/guardian to trigger refresh");
  const headers = {};
  if (ADMIN_TOKEN) headers.Authorization = `Bearer ${ADMIN_TOKEN}`;
  const g = await call("/api/guardian", { method: "GET", headers });
  if (!g.ok) {
    console.warn("guardian call failed:", g.error || g.status, g.body);
    console.warn("Continuing anyway to re-check /api/state");
  } else {
    console.log("guardian call status:", g.status);
  }

  // small pause to allow state to update on server
  await new Promise(r => setTimeout(r, 1200));

  console.log("\n3) Fetching /api/state (after)");
  const st2 = await call("/api/state");
  if (!st2.ok) {
    console.warn("Could not fetch /api/state (after):", st2.error || st2.status);
    return;
  }
  const stateResp2 = st2.body && st2.body.state ? st2.body.state : (st2.body || {});
  await printStateSnapshot("STATE AFTER REFRESH:", stateResp2);

  console.log("\n4) Fetching /api/kite/trades (latest)");
  const t = await call("/api/kite/trades");
  if (!t.ok) {
    console.warn("/api/kite/trades failed:", t.error || t.status, t.body);
    return;
  }
  const trades = (t.body && t.body.trades) ? t.body.trades : (t.body || []);
  if (Array.isArray(trades) && trades.length) {
    const latest = trades[trades.length - 1];
    console.log("\nLatest trade (from /api/kite/trades):");
    console.log(JSON.stringify(latest, null, 2));
    // if trade has timestamp fields, print a friendly time
    const tsCandidate = latest._ts || latest.ts || latest.exchange_timestamp || latest.trade_time || latest.created_at || latest._iso || null;
    if (tsCandidate) {
      const ms = Number(tsCandidate);
      console.log("Trade timestamp ->", fmtTs(ms));
    }
  } else {
    console.log("No trades returned from /api/kite/trades");
  }

  console.log("\nIntegration run complete.\n");
}

async function runFallbackUnitTest() {
  console.log("\n--- Running local unit test fallback (same as earlier test-sell-delta) ---");

  // in-memory state similar to earlier test
  let STATE = {
    last_mtm: 10000,
    last_mtm_ts: Date.now() - 50000,
    consecutive_losses: 0,
    last_sell_ts: 0,
    last_realised_change: 0,
    realised: 0,
    unrealised: -6000,
    capital_day_915: 100000,
    max_loss_pct: 20,
    max_consecutive_losses: 3,
    cooldown_min: 15,
    cooldown_until: 0
  };

  function fmtS(s) {
    console.log(JSON.stringify(s, null, 2));
  }

  function now() { return Date.now(); }

  async function setState(s) { STATE = { ...s }; }
  async function getState() { return { ...STATE }; }
  async function markTripped(reason, meta) { console.log("TRIP:", reason, meta); STATE.tripped_day = true; }

  async function evaluateSellMock(mtmNow) {
    const state = await getState();
    const prevMtm = Number(state.last_mtm ?? 0);
    const realisedDelta = mtmNow - prevMtm;
    const isLoss = realisedDelta < 0;
    let consec = Number(state.consecutive_losses ?? 0);
    const windowMin = Number(state.consecutive_time_window_min ?? 60);
    const lastLossTs = Number(state.last_loss_ts ?? 0);
    const nowTs = now();

    if (isLoss) {
      if (!lastLossTs || (nowTs - lastLossTs) > windowMin * 60 * 1000) consec = 1;
      else consec++;
      state.last_loss_ts = nowTs;
      state.cooldown_until = nowTs + Number(state.cooldown_min ?? 15) * 60 * 1000;
    } else {
      consec = 0;
    }

    state.last_mtm = mtmNow;
    state.last_mtm_ts = nowTs;
    state.last_realised_change = realisedDelta;
    state.last_realised_change_ts = nowTs;
    state.last_sell_ts = nowTs;
    state.consecutive_losses = consec;
    await setState(state);

    if (Number(state.max_consecutive_losses ?? 0) > 0 && consec >= Number(state.max_consecutive_losses ?? 0) && !state.tripped_day) {
      await markTripped("consecutive_losses", { consec, realisedDelta, mtm: mtmNow });
    }
    return state;
  }

  console.log("\nInitial state:");
  fmtS(STATE);

  console.log("\nSELL #1 => mtmNow = 9500 (loss)");
  await evaluateSellMock(9500);
  fmtS(STATE);

  console.log("\nSELL #2 => mtmNow = 9000 (loss)");
  await evaluateSellMock(9000);
  fmtS(STATE);

  console.log("\nSELL #3 => mtmNow = 9400 (profit)");
  await evaluateSellMock(9400);
  fmtS(STATE);

  console.log("\nDone (fallback local test).");
}

// Run main
runIntegration().catch(err => {
  console.error("Integration script error:", err && err.stack ? err.stack : err);
  process.exit(1);
});
