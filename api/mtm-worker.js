// api/mtm-worker.js
import { kv, todayKey } from "./_lib/kv.js";
import { instance } from "./_lib/kite.js";

export const config = {
  runtime: "nodejs20",
};

// === helpers ===
async function loadTradebook() {
  try {
    const raw = await kv.get("guardian:tradebook");
    if (!raw) return [];
    return JSON.parse(raw);
  } catch {
    return [];
  }
}

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

async function saveStatePatch(patch = {}) {
  const key = `risk:${todayKey()}`;
  const cur = (await kv.get(key)) || {};
  const current = typeof cur === "string" ? JSON.parse(cur) : cur;
  const next = { ...current, ...patch };
  await kv.set(key, next);
  return next;
}

async function getLTP(token) {
  const raw = await kv.get(`ltp:${token}`);
  if (!raw) return null;
  if (typeof raw === "string") {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

// ==== MAIN HANDLER ====
export default async function handler(req, res) {
  try {
    const kc = await instance();

    // 1) Load tradebook (today)
    const trades = await loadTradebook();

    // Build intraday grouped trades
    const intraday = {}; 
    for (const t of trades) {
      const sym = t.tradingsymbol;
      if (!sym) continue;

      const qty = Number(t.quantity) || 0;
      const price = Number(t.price_normalized || t.average_price || t.avg_price || t.price || 0);

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

    // Realised PNL so far = sum of closed trades:
    let realisedToday = 0;
    for (const sym in intraday) {
      const info = intraday[sym];
      const closed = Math.min(info.buyQty, info.sellQty);
      if (closed > 0) {
        const buyAvg = info.buyQty ? info.buyVal / info.buyQty : 0;
        const sellAvg = info.sellQty ? info.sellVal / info.sellQty : 0;
        realisedToday += (sellAvg - buyAvg) * closed;
      }
    }

    // 2) Fetch open positions from Kite
    const pos = await kc.getPositions();
    const net = pos?.net || [];

    // 3) Load existing baselines
    const baselines = await loadBaselines();
    const updatedBaselines = {};

    let totalUnrealised = 0;

    // For each open position:
    for (const p of net) {
      const symbol = p.tradingsymbol;
      const token = p.instrument_token;
      const qty = Number(p.net_quantity);

      if (!symbol || !token || qty === 0) continue;

      // Get latest LTP
      const ltpObj = await getLTP(token);
      if (!ltpObj || !ltpObj.last_price) continue;
      const LTP = Number(ltpObj.last_price);

      // Determine baseline price:
      let baselinePrice = null;

      // Case A: Intraday trades exist for this symbol
      if (intraday[symbol] && intraday[symbol].buyQty + intraday[symbol].sellQty > 0) {
        // fresh intraday position baseline = weighted avg of today's buys (or sells for short)
        const info = intraday[symbol];
        const remaining = Math.abs(info.buyQty - info.sellQty);

        if (remaining > 0 && info.buyQty > info.sellQty) {
          // net long
          baselinePrice = info.buyVal / info.buyQty;
        } else if (remaining > 0 && info.sellQty > info.buyQty) {
          // net short
          baselinePrice = info.sellVal / info.sellQty;
        }
      }

      // Case B: No intraday trades → Overnight or carried-over qty
      if (!baselinePrice) {
        // If baseline already saved (software started earlier), reuse it
        if (baselines[symbol] && baselines[symbol].qty === qty) {
          baselinePrice = baselines[symbol].price;
        } else {
          // First time seeing this today → baseline = LTP
          baselinePrice = LTP;
        }
      }

      // Compute unrealised for this symbol
      const direction = qty > 0 ? 1 : -1;
      const symbolUPNL = (LTP - baselinePrice) * qty * direction;

      totalUnrealised += symbolUPNL;

      // Update baseline entry
      updatedBaselines[symbol] = {
        qty: qty,
        price: baselinePrice
      };
    }

    // Save updated baselines
    await saveBaselines(updatedBaselines);

    // Save MTM in state
    const nextState = await saveStatePatch({
      realised: realisedToday,
      unrealised: totalUnrealised,
      live_balance: (realisedToday + totalUnrealised)
    });

    return res.json({
      ok: true,
      realised: realisedToday,
      unrealised: totalUnrealised,
      live_balance: realisedToday + totalUnrealised,
      baselines: updatedBaselines,
      state: nextState
    });

  } catch (err) {
    console.error("MTM Worker Error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
