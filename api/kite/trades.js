// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
// This version normalizes trades, uses live MTM for thresholds (same as dashboard),
// and ensures SELL updates persist to KV before enforcement logic runs.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getState, setState } from "../_lib/state.js";
import { recordSellOrder, computeTodayConsecutive, checkAndTriggerActionIfNeeded } from "../_lib/sellbook.js";
import { cancelPending, squareOffAll } from "../enforce.js";
import killNow from "../_lib/kill.js"; // <-- patched: use shared kill function

const TRADEBOOK_KEY = "guardian:tradebook";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  if (!a) return false;
  try {
    return a.trim() === (`Bearer ${process.env.ADMIN_KEY || ""}`).trim();
  } catch (e) {
    return false;
  }
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

async function fetchLiveMtm() {
  try {
    // try to fetch positions and compute total pnl
    const pos = await instance.getPositions();
    if (!pos) return null;
    let t = 0;
    for (const p of pos.net || []) {
      t += Number(p.m2m ?? p.unrealised ?? 0);
    }
    return t;
  } catch (e) {
    console.warn("fetchLiveMtm error:", e && e.message ? e.message : e);
    return null;
  }
}

async function fetchKitePositionsFallback() {
  try {
    const pos = await instance.getPositions();
    if (!pos) return { total_pnl: 0, unrealised: 0, positions: null, live_balance: 0, current_balance: 0 };
    const net = pos.net || [];
    let total = 0;
    let posArr = [];
    for (const p of net) {
      total += Number(p.m2m ?? p.unrealised ?? 0);
      posArr.push(p);
    }
    return { total_pnl: total, unrealised: total, positions: posArr, live_balance: 0, current_balance: 0 };
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
    const next = { ...(state || {}), tripped_day: true, tripped_reason: reason, last_enforced_at: now };
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
      console.error("Auto-enforce killNow failed:", e && e.stack ? e.stack : e);
    }
  } catch (e) {
    console.error("markTrippedAndKillInternal failed:", e && e.stack ? e.stack : e);
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

    // SELL handling using sellbook: record sell, compute consecutive based on sellbook, update guardian state and trigger enforcement if needed
    if (typ === "SELL") {
      // Read fresh state to avoid race
      const s = (await getState()) || {};
      const mtm = Number(liveMtm ?? (s.last_mtm ?? 0));
      const entry = {
        tradeTs: now,
        instrument: (trade.instrument || trade.tradingsymbol || trade.symbol || "unknown"),
        qty: Number(trade.quantity || trade.qty || trade.fill_quantity || 0),
        mtm,
      };

      try {
        // record sell to sellbook (today)
        await recordSellOrder(entry);
      } catch (e) {
        console.error('recordSellOrder failed', e && e.stack ? e.stack : e);
      }

      // recompute consecutive from sellbook and persist to guardian state
      try {
        const cons = await computeTodayConsecutive();
        const next = {
          ...(s || {}),
          last_mtm: Number(mtm),
          last_mtm_ts: now,
          last_realised_change: Number(mtm) - Number(s.last_mtm ?? 0),
          last_realised_change_ts: now,
          last_sell_ts: now,
          consecutive_losses: Number(cons.consecutiveCount || 0),
        };
        await setState(next);

        // read authoritative state back
        const final = (await getState()) || {};

        // If consecutive threshold reached and not already tripped, enforce
        if (maxConsec > 0 && Number(final.consecutive_losses ?? 0) >= maxConsec && !final.tripped_day) {
          await markTrippedAndKillInternal("consecutive_losses", { consec: final.consecutive_losses, mtm });
        }
      } catch (e) {
        console.error('sell handling (compute/persist) failed', e && e.stack ? e.stack : e);
      }

      return;
    }

    // BUY handling: buys during cooldown may trip
    if (typ === "BUY") {
      // read fresh state and check cooldown
      const s2 = (await getState()) || {};
      const cooldownUntil = Number(s2.cooldown_until ?? 0);
      if (!s2.tripped_day && cooldownUntil && now < cooldownUntil) {
        await markTrippedAndKillInternal("buy_during_cooldown", { last_mtm: s2.last_mtm ?? 0 });
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
        // fallthrough to fetch live trades if parsing fails
        console.warn("kite/trades fallback failed:", e && e.message ? e.message : e);
      }
    }

    // Prefer persisted tradebook
    let source = "live";
    let trades = [];

    try {
      const raw = await kv.get(TRADEBOOK_KEY);
      if (raw) {
        const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        trades = Array.isArray(arr) ? arr : [];
        source = "kv";
      } else {
        // fallback to live kite tradebook
        const resp = await instance.getTrades();
        trades = Array.isArray(resp) ? resp : [];
        source = "kite";
      }
    } catch (e) {
      console.warn("kite/trades fallback failed:", e && e.message ? e.message : e);
      try {
        const resp = await instance.getTrades();
        trades = Array.isArray(resp) ? resp : [];
        source = "kite";
      } catch (err) {
        console.error("kite/trades fallback failed twice:", err && err.message ? err.message : err);
      }
    }

    // normalize times to ms
    trades = trades.map((t) => {
      const ts = normalizeTsToMs(t.trade_time || t.timestamp || t.timestamp_ms || t.time || t.uts || t.exchange_time);
      return { ...t, trade_time: ts ?? t.trade_time };
    });

    // Evaluate auto logic on latest trade (if any)
    try {
      if (Array.isArray(trades) && trades.length) {
        const latest = trades[trades.length - 1];
        await evaluateTradeForAutoLogic(latest);
      }

      return res.status(200).json({ ok: true, source, trades });
    } catch (err) {
      console.error("kite/trades error:", err && err.stack ? err.stack : err);
      return res.status(500).json({ ok: false, error: String(err) });
    }
  } catch (err) {
    console.error("kite/trades top-level error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
