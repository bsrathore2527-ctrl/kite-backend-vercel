// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
//
// This patched version also auto-evaluates MTM and triggers enforcement logic (Option A)
// for Max Loss / Max Profit / Consecutive Losses / Cooldown violations.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getState, setState } from "../_lib/state.js";   // must exist or map to your own helpers
import { cancelPending, squareOffAll } from "../enforce.js";  // adjust import if needed

const TRADEBOOK_KEY = "guardian:tradebook";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function toNumberOrNull(v) {
  if (v === null || typeof v === "undefined") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTsToMs(ts) {
  if (ts === null || typeof ts === "undefined") return null;
  if (typeof ts === "number") {
    if (String(Math.trunc(ts)).length === 10) return ts * 1000;
    return ts;
  }
  if (/^\d+$/.test(String(ts).trim())) {
    const n = Number(ts);
    if (String(Math.trunc(n)).length === 10) return n * 1000;
    return n;
  }
  const parsed = Date.parse(String(ts));
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function normalizeTrade(t) {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };
  const candidates = [out.avg_price, out.average_price, out.trade_price, out.price, out.last_price];
  let price = null;
  for (const c of candidates) {
    const p = toNumberOrNull(c);
    if (p !== null && p !== 0) { price = p; break; }
  }
  out.price_normalized = price;
  const possibleTs = out._ts || out.trade_time || out.timestamp || out.exchange_timestamp || out.order_timestamp || out.created_at || out.ts;
  const ms = normalizeTsToMs(possibleTs);
  out._ts = ms || out._ts || null;
  out._iso = out._ts ? new Date(out._ts).toISOString() : null;
  return out;
}

// === Helpers for live MTM and enforcement ===

async function fetchKitePositions() {
  try {
    const kc = await instance();
    const data = await kc.getPositions();
    const net = data.net || [];
    let total = 0;
    for (const p of net) {
      total += Number(p.m2m ?? p.unrealised ?? 0);
    }
    return { total_pnl: total, unrealised: total };
  } catch (e) {
    console.error("fetchKitePositions error", e);
    return { total_pnl: 0 };
  }
}

async function markTrippedAndKill(reason, meta = {}) {
  try {
    const state = await getState();
    if (state.tripped_day) return;

    const now = Date.now();
    state.tripped_day = true;
    state.tripped_reason = reason;
    state.tripped_meta = { ...meta, at: now };
    state.block_new_orders = true;
    state.last_enforced_at = now;
    await setState(state);

    // Execute kill
    try {
      const kc = await instance();
      await cancelPending(kc);
      await squareOffAll(kc);
      console.log("Auto-kill executed:", reason, meta);
    } catch (e) {
      console.error("Auto-kill failed:", e);
    }
  } catch (err) {
    console.error("markTrippedAndKill error", err);
  }
}

async function evaluateTradeForAutoLogic(trade) {
  try {
    if (!trade || !trade.transaction_type) return;
    const typ = String(trade.transaction_type).toUpperCase();
    const state = await getState();
    const now = Date.now();

    // Fetch live MTM (for both BUY/SELL checks)
    const pos = await fetchKitePositions();
    const mtm = Number(pos.total_pnl ?? 0);

    // --- Global checks: Max Loss & Max Profit ---
    const maxLoss = Number(state.max_loss_abs ?? 0);
    const maxProfit = Number(state.p10_effective_amount ?? 0);

    if (!state.tripped_day) {
      if (mtm <= -maxLoss) {
        await markTrippedAndKill("max_loss_reached", { mtm, maxLoss });
        return;
      }
      if (mtm >= maxProfit) {
        await markTrippedAndKill("max_profit_reached", { mtm, maxProfit });
        return;
      }
    }

    // --- SELL logic: consecutive losses / cooldown ---
    if (typ === "SELL") {
      const lastMtm = Number(state.last_mtm ?? 0);
      const cooldownMin = Number(state.cooldown_min ?? 15);
      const maxConsec = Number(state.max_consecutive_losses ?? 0);
      let consec = Number(state.consecutive_losses ?? 0);

      const isLoss = mtm < 0;
      if (isLoss) {
        consec += 1;
        state.cooldown_until = now + cooldownMin * 60 * 1000;
      } else {
        consec = 0;
      }
      if (typeof state.last_mtm === "undefined" || mtm > lastMtm) {
        state.last_mtm = mtm;
        state.last_mtm_ts = now;
      }
      state.consecutive_losses = consec;
      state.last_sell_ts = now;
      await setState(state);

      if (maxConsec > 0 && consec >= maxConsec && !state.tripped_day) {
        await markTrippedAndKill("consecutive_losses", { consec, mtm });
      }
    }

    // --- BUY logic: kill if during cooldown ---
    if (typ === "BUY") {
      const cooldownUntil = Number(state.cooldown_until ?? 0);
      if (!state.tripped_day && cooldownUntil && now < cooldownUntil) {
        await markTrippedAndKill("buy_during_cooldown", { last_mtm: state.last_mtm });
      }
    }

  } catch (e) {
    console.error("evaluateTradeForAutoLogic error", e);
  }
}

// === Main handler ===
export default async function handler(req, res) {
  try {
    // Allow admin raw fetch
    if (isAdmin(req) && req.query && req.query.raw === "1") {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      try {
        const arr = JSON.parse(raw);
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: arr });
      } catch {
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: [] });
      }
    }

    // Try KV tradebook first
    let trades = [];
    let source = "empty";
    try {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      const arr = JSON.parse(raw);
      if (Array.isArray(arr) && arr.length) {
        trades = arr.slice(-200).map(normalizeTrade);
        source = "kv";
      }
    } catch (e) {
      console.warn("kite/trades kv read failed:", e);
    }

    // Fallback to live Kite trades if no KV trades
    if (!trades.length) {
      try {
        const kc = await instance();
        const live = (await kc.getTrades()) || [];
        trades = live.slice(-200).map(normalizeTrade);
        source = "kite";
      } catch (e) {
        console.warn("kite/trades fallback failed:", e);
      }
    }

    // Trigger automation on latest trade
    if (Array.isArray(trades) && trades.length) {
      const latest = trades[trades.length - 1];
      evaluateTradeForAutoLogic(latest); // async, fire-and-forget
    }

    return res.status(200).json({ ok: true, source, trades });
  } catch (err) {
    console.error("kite/trades error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
