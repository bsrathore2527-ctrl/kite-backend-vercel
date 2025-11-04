// api/state.js — Combined final version with realised-based trailing loss

import { Redis } from '@upstash/redis';

// --- Redis Helper (shared) ---
const redis = new Redis({
  url: process.env.UPSTASH_REDIS_REST_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

const todayKey = () => {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth()+1).padStart(2,'0');
  const dd = String(d.getDate()).padStart(2,'0');
  return `${y}${m}${dd}`;
};
const realisedKey = (day) => `day:${day}:realised`;
const openKey = (day, inst) => `day:${day}:open:${inst}`;
const processedKey = (day) => `day:${day}:processed_trades`;

// --- Realised tracking helpers ---
export async function processTrade(trade) {
  const day = todayKey();
  if (!trade || !trade.trade_id) throw new Error('missing trade_id');

  // Idempotency
  const already = await redis.sismember(processedKey(day), String(trade.trade_id));
  if (already) return { ok: true, reason: 'already_processed' };

  const side = String(trade.side).toLowerCase(); // 'buy' or 'sell'
  const inst = String(trade.instrument_token);
  const openListKey = openKey(day, inst);
  let qty = Math.abs(Number(trade.quantity));
  const price = Number(trade.price);

  if (side === 'buy') {
    await redis.rpush(openListKey, JSON.stringify({ qty, price, side: 'buy' }));
  } else if (side === 'sell') {
    let realisedDelta = 0;
    while (qty > 0) {
      const raw = await redis.lindex(openListKey, 0);
      if (!raw) {
        await redis.rpush(openListKey, JSON.stringify({ qty, price, side: 'sell' }));
        qty = 0;
        break;
      }
      const leg = JSON.parse(raw);
      if (leg.side !== 'buy') {
        await redis.rpush(openListKey, JSON.stringify({ qty, price, side: 'sell' }));
        qty = 0;
        break;
      }

      const matchQty = Math.min(qty, leg.qty);
      realisedDelta += (price - leg.price) * matchQty;

      if (leg.qty > matchQty) {
        await redis.lpop(openListKey);
        const remainingLeg = { qty: leg.qty - matchQty, price: leg.price, side: 'buy' };
        await redis.lpush(openListKey, JSON.stringify(remainingLeg));
      } else {
        await redis.lpop(openListKey);
      }

      qty -= matchQty;
    }

    if (realisedDelta !== 0) {
      await redis.incrby(realisedKey(day), realisedDelta);
    }
  } else {
    await redis.sadd(processedKey(day), String(trade.trade_id));
    return { ok: false, reason: 'bad_side' };
  }

  await redis.sadd(processedKey(day), String(trade.trade_id));
  return { ok: true };
}

export async function fetchDailyRealised() {
  const day = todayKey();
  const v = await redis.get(realisedKey(day));
  return { day, realised: v ? Number(v) : 0 };
}

// --- Main handler for UI ---
export default async function handler(req, res) {
  try {
    // You can keep your existing logic here for pulling live data.
    // This is an example base; replace with your real state if needed.
    let state = {
      capital_day_915: 100000,
      max_loss_pct: 10,
      trail_step_profit: 5000,
      p10: 10,
      p10_is_pct: true,
      unrealised: 19192.5,
    };

    // --- Realised-based trailing logic ---
    const capital = state.capital_day_915 || 100000;
    const max_loss_abs = state.max_loss_abs || Math.round(capital * ((state.max_loss_pct || 10) / 100));
    const trail_step = state.trail_step_profit || 0;
    const p10 = state.p10 || 0;
    const p10_is_pct = state.p10_is_pct;

    const { realised } = await fetchDailyRealised();
    const unrealised = state.unrealised || 0;
    const total_pnl = realised + unrealised;

    const p10_amount = p10_is_pct ? capital * (p10 / 100) : p10;

    let steps = 0;
    if (trail_step > 0 && realised >= p10_amount) {
      steps = 1 + Math.floor((realised - p10_amount) / trail_step);
    }

    let active_loss_floor = -max_loss_abs + steps * trail_step;
    active_loss_floor = Math.min(active_loss_floor, realised); // Clamp

    const remaining_to_max_loss = total_pnl - active_loss_floor;

    // Attach computed fields
    state.realised = realised;
    state.total_pnl = total_pnl;
    state.p10_effective_amount = p10_amount;
    state.active_loss_floor = active_loss_floor;
    state.remaining_to_max_loss = remaining_to_max_loss;

    return res.status(200).json({ ok: true, state });
  } catch (err) {
    console.error('state.js error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
