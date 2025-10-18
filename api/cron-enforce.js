import { KiteConnect } from "kiteconnect";
import { kv, IST, todayKey, nowIST } from "./_lib/kv.js";

const H = (h,m=0)=>({h,m});
const T = { marketStart: H(9,15), expiryGuard: H(14,30), expiryExitOnly: H(15,15), generalEnd: H(15,25), btstBlockEnd: H(15,30) };

function timeInRange(now, hm) { const d=new Date(now); d.setHours(hm.h, hm.m, 0, 0); return d; }
function fmt(d){ return d.toLocaleTimeString("en-IN",{timeZone:IST,hour12:false}); }

async function getKC() {
  const today = todayKey();
  const at = await kv.get(`kite_at:${today}`);
  if (!at) throw new Error("No access token for cron");
  const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  kc.setAccessToken(at);
  return kc;
}

async function getState() {
  const key = `risk:${todayKey()}`;
  let s = await kv.get(key);
  if (!s) s = {};
  return { key, s };
}

function within(now, from, to){ return now >= from && now <= to; }

export default async function handler(req, res) {
  const now = nowIST();
  const dayKey = todayKey();
  const { key, s } = await getState();
  const start = timeInRange(now, T.marketStart);
  const cutoff = timeInRange(now, T.generalEnd);
  const expiryWin = timeInRange(now, T.expiryGuard);
  const expiryExitOnly = timeInRange(now, T.expiryExitOnly);
  const btstBlockEnd = timeInRange(now, T.btstBlockEnd);

  try {
    const kc = await getKC();

    // Capital snapshot @ 09:15
    if (!s.capital_day_915 && now >= start) {
      try {
        const margins = await kc.getMargins();
        const eq = margins?.equity || {};
        s.capital_day_915 = Number(eq.net || eq.available?.cash || eq.available?.live_balance || 0);
      } catch { s.capital_day_915 = s.capital_day_915 || 0; }
    }

    // Read positions for realised/unrealised
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    const realised = net.reduce((a,p)=> a + (Number(p.realised)||0), 0);
    const unrealised = net.reduce((a,p)=> a + (Number(p.unrealised)||0), 0);

    // Track loss booking & cooldown/consecutive losses
    if (s.last_realised === undefined) s.last_realised = realised;
    const deltaReal = realised - (s.last_realised||0);
    if (deltaReal < 0) { // a realised loss was booked this tick
      s.consecutive_losses = (s.consecutive_losses||0) + 1;
      const mins = Number(s.cooldown_min||15);
      s.cooldown_until = now.getTime() + mins*60*1000;
    }
    s.last_realised = realised;

    // Compute dynamic loss floors
    const cap = Number(s.capital_day_915||0);
    const maxLossAbs = - (Number(s.max_loss_pct||10)/100) * cap; // e.g., -10%
    // Trailing: for every trail_step_profit gained, lift loss floor by same amount up to breakeven+
    const step = Number(s.trail_step_profit||5000);
    let dynFloor = maxLossAbs;
    if (step>0 && realised>0) {
      const steps = Math.floor(realised/step);
      dynFloor = Math.min(0, maxLossAbs + steps*step);
    }

    // Profit locks
    s.profit_lock_10 = s.profit_lock_10 || (realised >= 0.10*cap);
    s.profit_lock_20 = s.profit_lock_20 || (realised >= 0.20*cap);
    if (s.profit_lock_20) s.block_new_orders = true; // always block new at 20%

    // Loss breaches
    const totalPnL = realised + unrealised;
    if (totalPnL <= maxLossAbs) { s.tripped_day = true; s.max_loss_hit_time = s.max_loss_hit_time || now.toISOString(); }
    if (realised <= dynFloor) { s.tripped_day = true; }

    // Expiry flag (admin or detect later)
    const expiryMode = Boolean(s.expiry_flag);

    // Evaluate orderbook to enforce cancellations
    const orders = await kc.getOrders();
    const openOrders = orders.filter(o => ["OPEN","TRIGGER PENDING"].includes(o.status));

    // Helper: cancel opens
    async function cancelAll(list){
      for (const o of list) { try { await kc.cancelOrder(o.variety||"regular", o.order_id); } catch {} }
    }
    // Helper: square all positions market IOC
    async function squareAll() {
      for (const p of net) {
        const q = Number(p.quantity)||0; if (q===0) continue;
        const tx = q>0 ? "SELL" : "BUY";
        try { await kc.placeOrder("regular", { exchange:p.exchange, tradingsymbol:p.tradingsymbol, transaction_type:tx, quantity:Math.abs(q), product:p.product||"MIS", order_type:"MARKET", validity:"IOC" }); } catch {}
      }
    }

    // 1) Hard day tripped → cancel + square + block (and BTST blocked till 15:30)
    if (s.tripped_day && within(now, start, btstBlockEnd)) {
      await cancelAll(openOrders);
      if (now <= cutoff) await squareAll(); // square only until 15:25
      s.block_new_orders = true;
    }

    // 2) 3 consecutive losses → day over
    if (!s.tripped_day && (s.consecutive_losses||0) >= Number(s.max_consecutive_losses||3)) {
      await cancelAll(openOrders);
      if (now <= cutoff) await squareAll();
      s.tripped_day = true; s.block_new_orders = true;
    }

    // 3) Revenge cooldown: cancel new opens; square fresh fills
    const inCooldown = (s.cooldown_until||0) > now.getTime();
    if (inCooldown) {
      await cancelAll(openOrders);
      // Any NEW net exposure opened during cooldown? If so, flat it.
      for (const p of net) {
        if (Math.abs(Number(p.quantity)||0) !== 0 && (deltaReal<0 || true)) { // simple heuristic
          const q = Number(p.quantity)||0; const tx = q>0?"SELL":"BUY";
          try { await kc.placeOrder("regular", { exchange:p.exchange, tradingsymbol:p.tradingsymbol, transaction_type:tx, quantity:Math.abs(q), product:p.product||"MIS", order_type:"MARKET", validity:"IOC" }); } catch {}
        }
      }
    }

    // 4) Profit lock 10% → new only if admin explicitly allowed (flag s.allow_new_after_lock10)
    if (s.profit_lock_10 && !s.allow_new_after_lock10) s.block_new_orders = true;

    // 5) Expiry-day after 14:30 rules
    if (expiryMode && now >= expiryWin) {
      if (realised < 0) {
        s.block_new_orders = true; // in loss → no new trades
      } else {
        // in profit → cap new exposure to 3% of capital (enforced in place-order path; here we cancel oversized opens)
        const maxExp = 0.03 * cap;
        const oversized = openOrders.filter(o => Number(o.quantity||0)*Number(o.price||0) > maxExp);
        await cancelAll(oversized);
      }
    }

    // 6) After 15:15 on expiry day → exit-only
    if (expiryMode && now >= expiryExitOnly) s.block_new_orders = true;

    // 7) Global block new → cancel any opens
    if (s.block_new_orders) await cancelAll(openOrders);

    // 8) BTST penalties for post-14:30 entries >10% (full close before 15:30)
    if (now <= timeInRange(now, T.generalEnd)) {
      // marker only; actual detection of entry-time needs order/trade times; simplified here
    }
    if (s.tripped_day && now > cutoff && now <= btstBlockEnd) {
      await squareAll(); // ensure flat into close if max loss day
    }

    // persist
    s.realised = realised; s.unrealised = unrealised;
    await kv.set(key, s, { ex: 60*60*24*2 });
    res.json({ ok:true, time: fmt(now), realised, unrealised, cap, tripped:s.tripped_day, block:s.block_new_orders, losses:s.consecutive_losses });
  } catch (e) {
    res.status(200).json({ ok:false, error: e.message });
  }
}
