// api/guardian.js
// Evaluates live PnL, funds, and flips tripped_day/block_new_orders flags
// Used with /api/enforce.js to control automated risk rules.

import { instance } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js";

function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });

async function getPositionsAndPnL(kc) {
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let realised = 0, unrealised = 0;
    for (const p of net) {
      realised += Number(p.realised || 0);
      unrealised += Number(p.unrealised || 0);
    }
    return { realised, unrealised, total: realised + unrealised };
  } catch (e) {
    return { realised: 0, unrealised: 0, total: 0, error: e.message };
  }
}

async function getFundsBalance(kc) {
  try {
    const funds = await kc.getMargins();
    const bal =
      funds?.equity?.available?.live_balance ??
      funds?.equity?.available?.cash ??
      funds?.equity?.net ??
      0;
    return { funds, balance: bal };
  } catch (e) {
    return { funds: null, balance: 0, error: e.message };
  }
}

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") return bad(res, "Method not allowed");

    const key = `risk:${todayKey()}`;
    const s = (await kv.get(key)) || {};

    // Acquire Zerodha instance
    let kc;
    try {
      kc = await instance();
    } catch (e) {
      return ok(res, { ok: false, note: "Kite not connected", error: e.message });
    }

    // Fetch live funds + PnL
    const { funds, balance } = await getFundsBalance(kc);
    const { realised, unrealised, total } = await getPositionsAndPnL(kc);

    const capital_day_915 =
      s.capital_day_915 && s.capital_day_915 > 0 ? s.capital_day_915 : balance;
    const loss_limit = (s.max_loss_pct ?? 10) / 100 * capital_day_915;

    // Update trailing profit logic
    const realised_profit = realised > 0 ? realised : 0;
    let tripped_day = s.tripped_day ?? false;
    let block_new_orders = s.block_new_orders ?? false;
    let profit_lock_10 = s.profit_lock_10 ?? false;
    let profit_lock_20 = s.profit_lock_20 ?? false;

    // Loss breach
    if (total <= -loss_limit) {
      tripped_day = true;
      block_new_orders = true;
    }

    // Profit trailing lock
    if (realised_profit >= 0.1 * capital_day_915) profit_lock_10 = true;
    if (realised_profit >= 0.2 * capital_day_915) profit_lock_20 = true;

    // Update stored state
    const next = {
      ...s,
      current_balance: balance,
      realised,
      unrealised,
      totalPnL: total,
      tripped_day,
      block_new_orders,
      profit_lock_10,
      profit_lock_20,
      capital_day_915,
      last_checked: Date.now()
    };
    await kv.set(key, next);

    const resp = {
      ok: true,
      time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }),
      cap: capital_day_915,
      realised,
      unrealised,
      totalPnL: total,
      loss_limit,
      breached: tripped_day,
      profit_lock_10,
      profit_lock_20,
      block_new_orders
    };
    return ok(res, resp);
  } catch (err) {
    console.error("GUARDIAN ERR:", err && err.stack ? err.stack : err);
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
}
