// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
// This version normalizes trades, uses live MTM for thresholds (same as dashboard),
// and ensures SELL updates persist to KV before enforcement logic runs.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";
import { getState, setState } from "../_lib/state.js";

import {
  recordSellOrder,
  computeTodayConsecutive,
} from "../_lib/sellbook.js";

import killNow from "../_lib/kill.js";

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
    const pos = await instance.getPositions();
    if (!pos) return null;
    let t = 0;
    for (const p of pos.net || []) {
      t += Number(p.m2m ?? p.unrealised ?? 0);
    }
    return t;
  } catch (e) {
    console.warn("fetchLiveMtm error:", e);
    return null;
  }
}

/** fallback positions fetch */
async function fetchKitePositionsFallback() {
  try {
    const pos = await instance.getPositions();
    if (!pos) return { total_pnl: 0 };
    const net = pos.net || [];
    let total = 0;
    for (const p of net) {
      total += Number(p.m2m ?? p.unrealised ?? 0);
    }
    return { total_pnl: total };
  } catch (e) {
    console.error("fetchKitePositionsFallback error", e);
    return { total_pnl: 0 };
  }
}

/** Unified kill handler */
async function markTrippedAndKillInternal(reason, meta = {}) {
  try {
    const state = await getState();
    if (state?.tripped_day) return;

    const now = Date.now();

    const next = {
      ...(state || {}),
      tripped_day: true,
      tripped_reason: reason,
      last_enforced_at: now,
    };

    await setState(next);

    try {
      const result = await killNow({ meta: { reason, ...meta } });

      await setState({
        ...next,
        admin_last_enforce_result: result,
      });

      console.log("Auto-enforce executed:", reason, result);
    } catch (e) {
      console.error("killNow failed:", e);
    }
  } catch (e) {
    console.error("markTrippedAndKillInternal failed:", e);
  }
}

//
// =======================
//   AUTO-LOGIC PROCESSOR
// =======================
//
async function evaluateTradeForAutoLogic(trade) {
  if (!trade || !trade.transaction_type) return;

  try {
    const typ = String(trade.transaction_type).toUpperCase();
    const state = (await getState()) || {};
    const now = Date.now();

    // Live MTM (same as dashboard)
    let liveMtm = await fetchLiveMtm();
    if (liveMtm === null) {
      try {
        const fb = await fetchKitePositionsFallback();
        liveMtm = Number(fb.total_pnl ?? state.last_mtm ?? 0);
      } catch (e) {
        liveMtm = Number(state.last_mtm ?? 0);
      }
    }

    const maxLossAbs = Number(state.max_loss_abs || 0);
    const maxProfitAmt = Number(state.p10_effective_amount ?? 0);
    const maxConsec = Number(state.max_consecutive_losses ?? 0);

    //
    // === GLOBAL THRESHOLD CHECKS (MAX LOSS / PROFIT)
    //
    if (!state.tripped_day) {
      if (maxLossAbs > 0 && liveMtm <= -maxLossAbs) {
        return await markTrippedAndKillInternal("max_loss_reached", {
          mtm: liveMtm,
          maxLossAbs,
        });
      }
      if (maxProfitAmt > 0 && liveMtm >= maxProfitAmt) {
        return await markTrippedAndKillInternal("max_profit_reached", {
          mtm: liveMtm,
          maxProfitAmt,
        });
      }
    }

    //
    // ===========================================
    //   SELL HANDLING (OUR NEW SELLBOOK LOGIC)
    // ===========================================
    //
    if (typ === "SELL") {
      const s = (await getState()) || {};
      const mtm = Number(liveMtm ?? (s.last_mtm ?? 0));

      const entry = {
        tradeTs: now,
        instrument:
          trade.instrument ||
          trade.tradingsymbol ||
          trade.symbol ||
          "unknown",
        qty:
          Number(trade.quantity ||
          trade.qty ||
          trade.fill_quantity ||
          0),
        mtm,
      };

      // 1) Record SELL in Sellbook
      try {
        await recordSellOrder(entry);
      } catch (e) {
        console.error("recordSellOrder failed", e);
      }

      // 2) Compute consecutive-worsening count
      let cons = { consecutiveCount: 0 };
      try {
        cons = await computeTodayConsecutive();
      } catch (e) {
        console.error("computeTodayConsecutive failed", e);
      }

      // 3) Update guardian state
      const next = {
        ...(s || {}),
        last_mtm: mtm,
        last_mtm_ts: now,
        last_realised_change: mtm - Number(s.last_mtm ?? 0),
        last_realised_change_ts: now,
        last_sell_ts: now,
        consecutive_losses: Number(cons.consecutiveCount || 0),
      };

      await setState(next);

      const final = (await getState()) || {};

      // 4) Enforce if triggered
      if (
        maxConsec > 0 &&
        final.consecutive_losses >= maxConsec &&
        !final.tripped_day
      ) {
        await markTrippedAndKillInternal("consecutive_losses", {
          consec: final.consecutive_losses,
          mtm,
        });
      }

      return;
    }

    //
    // BUY HANDLING (unchanged logic)
    //
    if (typ === "BUY") {
      const s2 = (await getState()) || {};
      const cooldownUntil = Number(s2.cooldown_until ?? 0);
      if (!s2.tripped_day && cooldownUntil && now < cooldownUntil) {
        await markTrippedAndKillInternal("buy_during_cooldown", {
          last_mtm: s2.last_mtm ?? 0,
        });
      }
    }
  } catch (e) {
    console.error("evaluateTradeForAutoLogic error:", e);
  }
}

//
// ======================
//      API HANDLER
// ======================
//
export default async function handler(req, res) {
  try {
    //
    // Admin raw dump
    //
    if (isAdmin(req) && req.query?.raw === "1") {
      const raw = await kv.get(TRADEBOOK_KEY);
      try {
        const arr = typeof raw === "string" ? JSON.parse(raw) : raw;
        return res.status(200).json({
          ok: true,
          source: "kv",
          raw: true,
          trades: Array.isArray(arr) ? arr : [],
        });
      } catch {}
    }

    let trades = [];
    let source = "live";

    //
    // Prefer KV tradebook
    //
    try {
      const raw = await kv.get(TRADEBOOK_KEY);
      if (raw) {
        trades = typeof raw === "string" ? JSON.parse(raw) : raw;
        source = "kv";
      } else {
        const live = await instance.getTrades();
        trades = Array.isArray(live) ? live : [];
        source = "kite";
      }
    } catch {
      const live = await instance.getTrades();
      trades = Array.isArray(live) ? live : [];
      source = "kite";
    }

    //
    // Normalize trade timestamps
    //
    trades = trades.map((t) => ({
      ...t,
      trade_time:
        normalizeTsToMs(
          t.trade_time ||
            t.timestamp_ms ||
            t.timestamp ||
            t.time ||
            t.exchange_time
        ) ?? t.trade_time,
    }));

    //
    // Run AUTO LOGIC on the latest trade
    //
    if (Array.isArray(trades) && trades.length > 0) {
      const latest = trades[trades.length - 1];
      await evaluateTradeForAutoLogic(latest);
    }

    return res.status(200).json({ ok: true, source, trades });
  } catch (e) {
    console.error("kite/trades error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
