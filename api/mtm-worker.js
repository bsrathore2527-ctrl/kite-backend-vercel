// api/mtm-worker.js
import { kv, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export const config = {
  runtime: "nodejs20",
};

// === Load today's tradebook ===
async function loadTradebook() {
  try {
    const raw = await kv.get("guardian:tradebook");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

// === Baseline storage helpers ===
async function loadBaselines() {
  const key = `baseline:${todayKey()}`;
  try {
    const raw = await kv.get(key);
    if (!raw) return {};
    return typeof raw === "string" ? JSON.parse(raw) : raw;
  } catch {
    return {};
  }
}

async function saveBaselines(obj) {
  const key = `baseline:${todayKey()}`;
  await kv.set(key, obj);
}

// === Patch MTM into state ===
async function saveStatePatch(patch = {}) {
  const key = `risk:${todayKey()}`;
  const cur = (await kv.get(key)) || {};
  const current = typeof cur === "string" ? JSON.parse(cur) : cur;

  const next = { ...current, ...patch };
  await kv.set(key, next);
  return next;
}

// === Get LTP stored by ltp-poll-worker ===
async function getLTP(token) {
  const raw = await kv.get(`ltp:${token}`);
  if (!raw) return null;
  return typeof raw === "string" ? JSON.parse(raw) : raw;
}

// === MAIN HANDLER ===
export default async function handler(req, res) {
  try {
    const kc = await instance();

    // -------------------------------------------------
    // 1) LOAD TRADEBOOK → DERIVE INTRADAY BUY/SELL LOGIC
    // -------------------------------------------------
    const trades = await loadTradebook();

    const intraday = {}; // symbol → { buyQty, buyVal, sellQty, sellVal }

    for (const t of trades) {
      const sym = t.tradingsymbol;
      if (!sym) continue;

      const qty = Number(t.quantity) || 0;
      const price = Number(
        t.price_normalized ||
        t.average_price ||
        t.avg_price ||
        t.price ||
        0
      );

      if (!intraday[sym]) {
        intraday[sym] = { buyQty: 0, buyVal: 0, sellQty: 0, sellVal: 0 };
      }

      if (t.transaction_type === "BUY") {
        intraday[sym].buyQty += qty;
        intraday[sym].buyVal += qty * price;
      } else if (t.transaction_type === "SELL") {
        intraday[sym].sellQty += qty;
        intraday[sym].sellVal += qty * price;
      }
    }

    // REALISED = sum of closed intraday trades
    let realisedToday = 0;
    for (const sym in intraday) {
      const info = intraday[sym];
      const closedQty = Math.min(info.buyQty, info.sellQty);

      if (closedQty > 0) {
        const buyAvg = info.buyVal / info.buyQty;
        const sellAvg = info.sellVal / info.sellQty;
        realisedToday += (sellAvg - buyAvg) * closedQty;
      }
    }

    // -------------------------------------------------
    // 2) FETCH OPEN POSITIONS
    // -------------------------------------------------
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    // -------------------------------------------------
    // 3) LOAD EXISTING BASELINES
    // -------------------------------------------------
    const oldBaselines = await loadBaselines();
    const newBaselines = {};

    let totalUnrealised = 0;

    // -------------------------------------------------
    // 4) PROCESS EACH OPEN POSITION
    // -------------------------------------------------
    for (const p of net) {
      const symbol = p.tradingsymbol;
      const token = p.instrument_token;
      const qty = Number(p.net_quantity);

      if (!symbol || !token || qty === 0) continue;

      const ltpObj = await getLTP(token);
      if (!ltpObj?.last_price) continue;

      const LTP = Number(ltpObj.last_price);

      // Determine baseline price:
      let baselinePrice = null;

      // CASE A — INTRADAY TRADES EXIST → USE TODAY'S TRADE WEIGHTED AVG
      if (intraday[symbol] &&
          (intraday[symbol].buyQty + intraday[symbol].sellQty) > 0) {

        const info = intraday[symbol];
        const remaining = Math.abs(info.buyQty - info.sellQty);

        if (remaining > 0 && info.buyQty > info.sellQty) {
          baselinePrice = info.buyVal / info.buyQty;   // long
        } else if (remaining > 0 && info.sellQty > info.buyQty) {
          baselinePrice = info.sellVal / info.sellQty; // short
        }
      }

      // CASE B — NO INTRADAY TRADES → OVERNIGHT POSITION
      if (!baselinePrice) {
        if (oldBaselines[symbol] && oldBaselines[symbol].qty === qty) {
          baselinePrice = oldBaselines[symbol].price;
        } else {
          baselinePrice = LTP;  // first-time baseline
        }
      }

      // Compute MTM for this symbol
      const direction = qty > 0 ? 1 : -1;
      const symbolUPNL = (LTP - baselinePrice) * qty * direction;

      totalUnrealised += symbolUPNL;

      // store new baseline
      newBaselines[symbol] = {
        qty,
        price: baselinePrice
      };
    }

    // -------------------------------------------------
    // 5) SAVE UPDATED BASELINES
    // -------------------------------------------------
    await saveBaselines(newBaselines);

    // -------------------------------------------------
    // 6) SAVE MTM IN STATE
    // -------------------------------------------------
    const total_pnl = realisedToday + totalUnrealised;

    const nextState = await saveStatePatch({
      realised: realisedToday,
      unrealised: totalUnrealised,
      total_pnl: total_pnl
      // DO NOT TOUCH live_balance
    });

    return res.json({
      ok: true,
      realised: realisedToday,
      unrealised: totalUnrealised,
      total_pnl,
      baselines: newBaselines,
      state: nextState
    });

  } catch (err) {
    console.error("MTM Worker Error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
