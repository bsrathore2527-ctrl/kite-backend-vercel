// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
// This version normalizes trades, uses live MTM for thresholds (same as dashboard),
// and ensures SELL updates persist to KV before enforcement logic runs.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getState, setState } from "../_lib/state.js";
import { cancelPending, squareOffAll } from "../enforce.js";
import killNow from "../_lib/kill.js"; // <-- patched: use shared kill function

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

// ✅ Clean, IST-safe helper
function todayStartMs() {
  // Compute start of "today" in IST, timezone-safe even on UTC servers.
  const now = new Date();
  const istNow = new Date(now.toLocaleString("en-IN", { timeZone: "Asia/Kolkata" }));
  istNow.setHours(0, 0, 0, 0);
  return istNow.getTime();
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

// Fetch live MTM the same way dashboard uses (sum of p.m2m or p.unrealised)
async function fetchLiveMtm() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) {
      total += Number(p.m2m ?? p.unrealised ?? 0);
    }
    return total;
  } catch (e) {
    console.error("fetchLiveMtm error", e && e.message ? e.message : e);
    return null;
  }
}

// Keep a fallback helper (returns an object shape if needed)
async function fetchKitePositionsFallback() {
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    let total = 0;
    const net = pos?.net || [];
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return { total_pnl: total, unrealised: total, positions: pos, live_balance: 0, current_balance: 0 };
  } catch (e) {
    console.error("fetchKitePositionsFallback error", e && e.message ? e.message : e);
    return { total_pnl: 0, unrealised: 0, positions: null, live_balance: 0, current_balance: 0 };
  }
}

/**
 * Reworked to call shared killNow() so behavior is identical to admin kill.
 * The previous code called cancelPending() and squareOffAll() here.
 */
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
      // Use the centralized killNow() so admin UI and auto-kill are identical.
      // killNow will attempt to cancel pending orders and square off positions.
      const result = await killNow({ meta: { reason, ...meta } });

      const audited = {
        ...next,
        admin_last_enforce_result: result,
      };
      await setState(audited);

      console.log("Auto-enforce executed (via killNow):", reason, result);
    } catch (e) {
      console.error("markTrippedAndKillInternal enforcement error (killNow):", e && e.message ? e.message : e);
      // attempt fallback: try older functions if killNow fails
      try {
        const cancelled = await cancelPending();
        const squared = await squareOffAll();
        const auditedFallback = {
          ...next,
          admin_last_enforce_result: { cancelled, squared, fallback: true, at: Date.now() },
        };
        await setState(auditedFallback);
        console.log("Auto-enforce fallback executed:", reason, { cancelled, squared });
      } catch (e2) {
        console.error("markTrippedAndKillInternal fallback enforcement error", e2 && e2.message ? e2.message : e2);
      }
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

    // Fetch live MTM (same as dashboard) for threshold checks
    let liveMtm = await fetchLiveMtm();
    if (liveMtm === null) {
      // fallback to older helper or last_mtm
      try {
        const fallback = await fetchKitePositionsFallback();
        liveMtm = Number(fallback?.total_pnl ?? state.last_mtm ?? 0);
      } catch (e) {
        liveMtm = Number(state.last_mtm ?? 0);
      }
    }

    const maxLossAbs = Number(state.max_loss_abs ?? 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);
    const cooldownMin = Number(state.cooldown_min ?? 15);
    const maxConsec = Number(state.max_consecutive_losses ?? 0);

    // If not yet tripped, check global thresholds using live MTM
    if (!state.tripped_day) {
      if (maxLossAbs > 0 && Number(liveMtm) <= -maxLossAbs) {
        console.log("AUTO-TRIP: max_loss_reached", { liveMtm, maxLossAbs });
        return await markTrippedAndKillInternal("max_loss_reached", { mtm: liveMtm, maxLossAbs });
      }
      if (maxProfitAmt > 0 && Number(liveMtm) >= maxProfitAmt) {
        console.log("AUTO-TRIP: max_profit_reached", { liveMtm, maxProfitAmt });
        return await markTrippedAndKillInternal("max_profit_reached", { mtm: liveMtm, maxProfitAmt });
      }
    }

    // SELL handling: persist last_mtm snapshot and consecutive loss bookkeeping
    if (typ === "SELL") {
      // Read fresh state again to avoid race
      const s = (await getState()) || {};
      // Determine mtm at this sell moment (use live MTM for snapshot)
      const mtm = Number(liveMtm ?? (s.last_mtm ?? 0));
      const prevLastMtm = Number(s.last_mtm ?? 0);
      const realisedDelta = Number(mtm) - prevLastMtm;
      const isLoss = realisedDelta < 0;

      let consec = Number(s.consecutive_losses ?? 0);
      if (isLoss) {
        consec += 1;
        s.cooldown_until = now + cooldownMin * 60 * 1000;
        s.last_loss_ts = now;
      } else {
        consec = 0;
      }

      // update persisted state with atomic set
      const next = {
        ...(s || {}),
        last_mtm: Number(mtm),
        last_mtm_ts: now,
        last_realised_change: realisedDelta,
        last_realised_change_ts: now,
        last_sell_ts: now,
        consecutive_losses: consec,
      };

      await setState(next);

      // read authoritative state back
      const final = (await getState()) || {};

      // If consecutive threshold reached and not already tripped, enforce
      if (maxConsec > 0 && Number(final.consecutive_losses ?? 0) >= maxConsec && !final.tripped_day) {
        await markTrippedAndKillInternal("consecutive_losses", { consec: final.consecutive_losses, mtm });
      }

      return;
    }

    // BUY handling: buys during cooldown may trip
    if (typ === "BUY") {
      const cooldownUntil = Number(state.cooldown_until ?? 0);
      if (!state.tripped_day && cooldownUntil && now < cooldownUntil) {
        await markTrippedAndKillInternal("buy_during_cooldown", { last_mtm: state.last_mtm ?? 0 });
      }
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
      await evaluateTradeForAutoLogic(latest);
    }

    return res.status(200).json({ ok: true, source, trades });
  } catch (err) {
    console.error("kite/trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
        }
