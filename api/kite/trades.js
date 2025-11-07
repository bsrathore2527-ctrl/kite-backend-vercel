// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
// This version filters persisted tradebook to only today's trades in IST (non-destructive).

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getState, setState } from "../_lib/state.js";
import { cancelPending, squareOffAll } from "../enforce.js";

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

  const candidates = [
    out.avg_price,
    out.average_price,
    out.trade_price,
    out.price,
    out.last_price,
  ];

  let price = null;
  for (const c of candidates) {
    if (typeof c !== "undefined" && c !== null && c !== "") {
      const p = Number(c);
      if (!Number.isNaN(p)) {
        price = p;
        break;
      }
    }
  }

  if (price !== null) {
    out.price_normalized = price;
    out.price = price;
  } else {
    out.price_normalized = null;
    out.price = typeof out.price !== "undefined" ? out.price : null;
  }

  const possibleTs =
    out._ts ||
    out.trade_time ||
    out.timestamp ||
    out.exchange_timestamp ||
    out.order_timestamp ||
    out.created_at ||
    out.ts;
  const ms = normalizeTsToMs(possibleTs);
  out._ts = ms || out._ts || null;
  out._iso = out._ts ? new Date(out._ts).toISOString() : null;

  return out;
}

// returns epoch ms for start of "today" in Asia/Kolkata
function todayStartMs() {
  // Create IST-local date at midnight and convert to epoch ms.
  // Approach: create a Date in the runtime's timezone that represents IST current time,
  // then set hours to 0 and convert to epoch.
  const now = new Date();
  // 'en-GB' with timeZone Asia/Kolkata yields a locale string for IST local time.
  const istStr = now.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" });
  const ist = new Date(istStr);
  ist.setHours(0, 0, 0, 0);
  // ist is a Date object representing today's midnight in IST, but its internal epoch depends on runtime;
  // to ensure correct epoch, compute by formatting back as UTC:
  // Return the epoch ms that corresponds to that IST midnight in absolute time.
  const offset = new Date().getTimezoneOffset() * 60000;
  return ist.getTime() - offset;
}

async function readTradebookFromKV() {
  try {
    const raw = await kv.get(TRADEBOOK_KEY);
    if (!raw) return [];
    let arr = [];
    if (typeof raw === "object") {
      arr = Array.isArray(raw) ? raw : [];
    } else if (typeof raw === "string") {
      const s = raw.trim();
      if (s.startsWith("[") || s.startsWith("{")) {
        try {
          const parsed = JSON.parse(s);
          arr = Array.isArray(parsed) ? parsed : [];
        } catch (e) {
          console.warn("kite/trades kv: invalid JSON, ignoring KV value", e.message);
          arr = [];
        }
      } else {
        console.warn("kite/trades kv: non-JSON string in KV, ignoring. head:", s.slice(0, 80));
        arr = [];
      }
    } else {
      arr = [];
    }

    if (!Array.isArray(arr) || arr.length === 0) return [];

    // Filter to only keep trades whose timestamp is >= start of today's IST (non-destructive).
    const startMs = todayStartMs();
    const todays = arr.filter(t => {
      if (!t) return false;
      const ts =
        t._ts ||
        t.ts ||
        t.exchange_timestamp ||
        t.fill_timestamp ||
        t.trade_time ||
        t._iso ||
        t.created_at;
      if (!ts) return false;
      const parsed =
        typeof ts === "number"
          ? ts
          : !isNaN(Number(ts))
          ? Number(ts)
          : Date.parse(String(ts)) || null;
      if (!parsed) return false;
      const ms = normalizeTsToMs(parsed) || (typeof parsed === "number" ? parsed : null);
      return ms && Number(ms) >= startMs;
    });

    return todays;
  } catch (e) {
    console.warn("kite/trades kv read failed:", e && e.message ? e.message : e);
    return [];
  }
}

async function fetchKitePositions() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return { total_pnl: total, unrealised: total, positions: pos, live_balance: 0, current_balance: 0 };
  } catch (e) {
    console.error("fetchKitePositions error", e && e.message ? e.message : e);
    return { total_pnl: 0, unrealised: 0, positions: null, live_balance: 0, current_balance: 0 };
  }
}

async function markTrippedAndKillInternal(reason, meta = {}) {
  try {
    const state = await getState();
    if (state && state.tripped_day) return;
    const now = Date.now();
    const next = {
      ...(state || {}),
      tripped_day: true,
      tripped_reason: reason,
      tripped_meta: { ...meta, at: now },
      block_new_orders: true,
      last_enforced_at: now,
    };
    await setState(next);

    try {
      const kc = await instance();
      const cancelled = await cancelPending(kc);
      const squared = await squareOffAll(kc);
      const audited = {
        ...next,
        admin_last_enforce_result: { cancelled, squared, at: Date.now() },
      };
      await setState(audited);
      console.log("Auto-enforce executed:", reason, { cancelled, squared });
    } catch (e) {
      console.error("markTrippedAndKillInternal enforcement error", e && e.message ? e.message : e);
    }
  } catch (e) {
    console.error("markTrippedAndKillInternal error", e && e.message ? e.message : e);
  }
}

async function evaluateTradeForAutoLogic(trade) {
  try {
    if (!trade || !trade.transaction_type) return;
    const typ = String(trade.transaction_type).toUpperCase();
    const state = (await getState()) || {};
    const now = Date.now();

    const pos = await fetchKitePositions();
    const mtm = Number(pos.total_pnl ?? 0);

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);
    const cooldownMin = Number(state.cooldown_min ?? 15);
    const maxConsec = Number(state.max_consecutive_losses ?? 0);

    if (!state.tripped_day) {
      if (maxLossAbs > 0 && mtm <= -maxLossAbs)
        return await markTrippedAndKillInternal("max_loss_reached", { mtm, maxLossAbs });
      if (maxProfitAmt > 0 && mtm >= maxProfitAmt)
        return await markTrippedAndKillInternal("max_profit_reached", { mtm, maxProfitAmt });
    }

    if (typ === "SELL") {
      let consec = Number(state.consecutive_losses ?? 0);
      const isLoss = mtm < 0;
      if (isLoss) {
        consec += 1;
        state.cooldown_until = now + cooldownMin * 60 * 1000;
      } else {
        consec = 0;
      }
      if (typeof state.last_mtm === "undefined" || mtm > Number(state.last_mtm ?? 0)) {
        state.last_mtm = mtm;
        state.last_mtm_ts = now;
      }
      state.consecutive_losses = consec;
      state.last_sell_ts = now;
      await setState(state);
      if (maxConsec > 0 && consec >= maxConsec && !state.tripped_day)
        await markTrippedAndKillInternal("consecutive_losses", { consec, mtm });
    }

    if (typ === "BUY") {
      const cooldownUntil = Number(state.cooldown_until ?? 0);
      if (!state.tripped_day && cooldownUntil && now < cooldownUntil)
        await markTrippedAndKillInternal("buy_during_cooldown", { last_mtm: state.last_mtm ?? 0 });
    }
  } catch (e) {
    console.error("evaluateTradeForAutoLogic error", e && e.message ? e.message : e);
  }
}

export default async function handler(req, res) {
  try {
    if (isAdmin(req) && req.query && req.query.raw === "1") {
      const raw = await kv.get(TRADEBOOK_KEY);
      try {
        const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        return res
          .status(200)
          .json({ ok: true, source: "kv", raw: true, trades: Array.isArray(arr) ? arr : [] });
      } catch (e) {
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: [] });
      }
    }

    let trades = [];
    let source = "empty";

    // Read persisted tradebook but only keep today's trades (IST) - non-destructive
    const arr = await readTradebookFromKV();
    if (Array.isArray(arr) && arr.length) {
      trades = arr.slice(-200).map(normalizeTrade);
      source = "kv";
    } else {
      try {
        const kc = await instance();
        const live = (await kc.getTrades()) || [];
        trades = live.slice(-200).map(normalizeTrade);
        source = "kite";
      } catch (e) {
        console.warn("kite/trades fallback failed:", e && e.message ? e.message : e);
      }
    }

    if (Array.isArray(trades) && trades.length) {
      const latest = trades[trades.length - 1];
      evaluateTradeForAutoLogic(latest);
    } else {
      // No trades found — still sync positions optionally if desired
      // (you can uncomment to always update state from positions even with no trades)
      // const pos = await fetchKitePositions();
      // await syncStateWithPositions(pos, null);
    }

    return res.status(200).json({ ok: true, source, trades });
  } catch (err) {
    console.error("kite/trades error:", err.stack || err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
    }
