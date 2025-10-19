// api/guardian.js
// Phase 1 Risk Engine (Daily): max loss, trailing, revenge cooldown, 3-loss stop,
// profit locks, expiry overlay, block-new + auto-cancel + square-off on breach.

import { KiteConnect } from "kiteconnect";
import { kv, IST, todayKey, nowIST } from "./_lib/kv.js";

const H = (h, m = 0) => ({ h, m });
const T = {
  marketStart: H(9, 15),
  expiryGuard: H(14, 30),
  expiryExitOnly: H(15, 15),
  generalEnd: H(15, 25),
  btstBlockEnd: H(15, 30),
};

function atHM(base, hm) {
  const d = new Date(base);
  d.setHours(hm.h, hm.m, 0, 0);
  return d;
}
function tstr(d) {
  return d.toLocaleTimeString("en-IN", { timeZone: IST, hour12: false });
}

async function getKC() {
  const today = todayKey();
  const at = await kv.get(`kite_at:${today}`);
  if (!at) throw new Error("No access token for guardian (visit /api/login today)");
  const kc = new KiteConnect({ api_key: process.env.KITE_API_KEY });
  kc.setAccessToken(at);
  return kc;
}
async function loadState() {
  const key = `risk:${todayKey()}`;
  const s = (await kv.get(key)) || {};
  return { key, s };
}

export default async function handler(req, res) {
  const now = nowIST();
  const start = atHM(now, T.marketStart);
  const cutoff = atHM(now, T.generalEnd);
  const btstBlockEnd = atHM(now, T.btstBlockEnd);
  const expiryGuard = atHM(now, T.expiryGuard);
  const expiryExitOnly = atHM(now, T.expiryExitOnly);

  try {
    const { key, s } = await loadState();
    const kc = await getKC();

    // 1) Capital snapshot @ 09:15
    if (!s.capital_day_915 && now >= start) {
      try {
        const margins = await kc.getMargins();
        const eq = margins?.equity || {};
        s.capital_day_915 = Number(
          eq.net ?? eq.available?.cash ?? eq.available?.live_balance ?? 0
        );
      } catch {
        s.capital_day_915 = s.capital_day_915 || 0;
      }
    }
    const cap = Number(s.capital_day_915 || 0);

    // 2) Pull positions + P&L
    const positions = await kc.getPositions();
    const net = positions?.net || [];
    const realised = net.reduce((a, p) => a + Number(p.realised || 0), 0);
    const unrealised = net.reduce((a, p) => a + Number(p.unrealised || 0), 0);
    const totalPnL = realised + unrealised;

    // 3) Track realised deltas → revenge cooldown & consecutive losses
    if (s.last_realised === undefined) s.last_realised = realised;
    const deltaReal = realised - (s.last_realised || 0);
    if (deltaReal < 0) {
      s.consecutive_losses = (s.consecutive_losses || 0) + 1;
      const mins = Number(s.cooldown_min || 15);
      s.cooldown_until = now.getTime() + mins * 60 * 1000;
    }
    s.last_realised = realised;

    // 4) Dynamic trailing floor from realised profit
    const maxLossAbs = -(Number(s.max_loss_pct ?? 10) / 100) * cap; // e.g., -10%
    const step = Number(s.trail_step_profit ?? 5000);
    let dynFloor = maxLossAbs;
    if (step > 0 && realised > 0) {
      const steps = Math.floor(realised / step);
      dynFloor = Math.min(0, maxLossAbs + steps * step);
    }

    // 5) Profit locks
    s.profit_lock_10 = s.profit_lock_10 || (cap > 0 && realised >= 0.1 * cap);
    s.profit_lock_20 = s.profit_lock_20 || (cap > 0 && realised >= 0.2 * cap);
    if (s.profit_lock_20) s.block_new_orders = true; // 20% => block new always
    if (s.profit_lock_10 && !s.allow_new_after_lock10) s.block_new_orders = true;

    // 6) Hard day breach checks
    if (totalPnL <= maxLossAbs || realised <= dynFloor) {
      s.tripped_day = true;
      s.max_loss_hit_time = s.max_loss_hit_time || now.toISOString();
    }

    // 7) Expiry overlay
    const isExpiry = Boolean(s.expiry_flag);
    const inExpiryGuard = isExpiry && now >= expiryGuard;
    const inExpiryExitOnly = isExpiry && now >= expiryExitOnly;

    // 8) Fetch open orders
    const orders = await kc.getOrders();
    const openOrders = orders.filter((o) =>
      ["OPEN", "TRIGGER PENDING"].includes(o.status)
    );

    // Helpers
    async function cancelAll(list) {
      for (const o of list) {
        try {
          await kc.cancelOrder(o.variety || "regular", o.order_id);
        } catch {}
      }
    }
    async function squareAll() {
      for (const p of net) {
        const q = Number(p.quantity || 0);
        if (q === 0) continue;
        const tx = q > 0 ? "SELL" : "BUY";
        try {
          await kc.placeOrder("regular", {
            exchange: p.exchange,
            tradingsymbol: p.tradingsymbol,
            transaction_type: tx,
            quantity: Math.abs(q),
            product: p.product || "MIS",
            order_type: "MARKET",
            validity: "IOC",
          });
        } catch {}
      }
    }

    // 9) Enforcements (priority order)

    // A) Day tripped (max loss / trailing) → cancel + square (till 15:25) + block
    if (s.tripped_day) {
      await cancelAll(openOrders);
      if (now <= cutoff) await squareAll();
      s.block_new_orders = true;
    }

    // B) 3 consecutive losses → day over
    if (!s.tripped_day && (s.consecutive_losses || 0) >= Number(s.max_consecutive_losses || 3)) {
      await cancelAll(openOrders);
      if (now <= cutoff) await squareAll();
      s.tripped_day = true;
      s.block_new_orders = true;
    }

    // C) Revenge cooldown → cancel opens + flatten any fresh exposure (simple heuristic)
    const inCooldown = (s.cooldown_until || 0) > now.getTime();
    if (inCooldown) {
      await cancelAll(openOrders);
      for (const p of net) {
        const q = Number(p.quantity || 0);
        if (q !== 0) {
          const tx = q > 0 ? "SELL" : "BUY";
          try {
            await kc.placeOrder("regular", {
              exchange: p.exchange,
              tradingsymbol: p.tradingsymbol,
              transaction_type: tx,
              quantity: Math.abs(q),
              product: p.product || "MIS",
              order_type: "MARKET",
              validity: "IOC",
            });
          } catch {}
        }
      }
    }

    // D) Expiry overlays
    if (inExpiryExitOnly) {
      s.block_new_orders = true; // 15:15 onward: exit only
    } else if (inExpiryGuard) {
      if (realised < 0) {
        s.block_new_orders = true; // after 14:30 and in loss → no new trades
      } else {
        // in profit: limit *new* exposure to 3% of capital (cancel obviously oversized opens)
        const maxExp = 0.03 * cap;
        const oversized = openOrders.filter((o) => {
          const qty = Number(o.quantity || 0);
          const px = Number(o.price || o.trigger_price || 0);
          return qty * px > maxExp && maxExp > 0;
        });
        if (oversized.length) await cancelAll(oversized);
      }
    }

    // E) Global block new ⇒ cancel any remaining opens
    if (s.block_new_orders) await cancelAll(openOrders);

    // F) Max-loss day BTST block window (15:25–15:30) ⇒ force flat
    if (s.tripped_day && now > cutoff && now <= btstBlockEnd) {
      await squareAll();
    }

    // Persist state
    s.realised = realised;
    s.unrealised = unrealised;
    await kv.set(key, s, { ex: 60 * 60 * 24 * 2 });

    return res.json({
      ok: true,
      time: tstr(now),
      cap,
      realised,
      unrealised,
      totalPnL,
      tripped_day: Boolean(s.tripped_day),
      block_new: Boolean(s.block_new_orders),
      consecutive_losses: s.consecutive_losses || 0,
      cooldown_active: inCooldown,
      profit_lock_10: Boolean(s.profit_lock_10),
      profit_lock_20: Boolean(s.profit_lock_20),
      expiry_flag: Boolean(s.expiry_flag),
    });
  } catch (e) {
    // Keep 200 so QStash doesn't spam retries; report error in payload
    return res.status(200).json({ ok: false, error: e.message || String(e) });
  }
  }
