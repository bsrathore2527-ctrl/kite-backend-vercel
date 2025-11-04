// api/kite/trades.js — Final merged version (processTrade + Upstash Redis)

import { Redis } from '@upstash/redis';

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

// --- Core trade processor ---
async function processTrade(trade) {
  const day = todayKey();
  if (!trade || !trade.trade_id) throw new Error('missing trade_id');

  const already = await redis.sismember(processedKey(day), String(trade.trade_id));
  if (already) return { ok: true, reason: 'already_processed' };

  const side = String(trade.side).toLowerCase();
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
    return { ok: false, reason: 'invalid_side' };
  }

  await redis.sadd(processedKey(day), String(trade.trade_id));
  return { ok: true };
}

// --- Main API Handler ---
export default async function handler(req, res) {
  if (req.method !== 'POST')
    return res.status(405).json({ ok: false, reason: 'method_not_allowed' });

  try {
    const trade = req.body;
    const r = await processTrade(trade);
    return res.json(r);
  } catch (err) {
    console.error('kite/trades.js error', err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
