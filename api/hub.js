// api/hub.js
// Unified router for: kite (funds/positions/orders/cancel-all/exit-all),
// admin (rules-set/kill/unlock), and guardian cron tick.

import { instance } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js"; // assumes your kv.js exports these

function send(res, code, body) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });
const unauth = (res) => send(res, 401, { ok: false, error: "Unauthorized" });
const nope = (res) => send(res, 405, { ok: false, error: "Method not allowed" });

function isAdmin(req) {
  const h = req.headers.authorization || "";
  const token = h.startsWith("Bearer ") ? h.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function kite() {
  return instance(); // from your _lib/kite.js
}

export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://local");
    const path = url.pathname; // e.g. /api/kite/funds

    // ------------------- KITE (READ + MAINTENANCE) -------------------
    if (path.startsWith("/api/kite/")) {
      const seg = path.replace("/api/kite/", "");
      const kc = await kite();

      if (req.method === "GET" && seg === "funds") {
        // new SDKs -> getMargins(); older -> margins()
        let funds;
        try {
          const m = await kc.getMargins?.() ?? await kc.margins?.();
          funds = m?.equity || m;
        } catch (e) {
          return bad(res, e.message || "Funds fetch failed");
        }
        return ok(res, { funds });
      }

      if (req.method === "GET" && seg === "positions") {
        const p = await kc.getPositions();
        return ok(res, { positions: p });
      }

      if (req.method === "GET" && seg === "orders") {
        const o = await kc.getOrders();
        return ok(res, { orders: o });
      }

      if (req.method === "POST" && seg === "cancel-all") {
        if (!isAdmin(req)) return unauth(res);
        const orders = await kc.getOrders();
        const pend = orders.filter(o => ["OPEN", "TRIGGER PENDING"].includes(o.status));
        let canceled = 0;
        for (const o of pend) {
          try {
            // try both signatures for compatibility
            try { await kc.cancelOrder(o.variety || "regular", o.order_id); }
            catch { await kc.cancelOrder(o.order_id, o.variety || "regular"); }
            canceled++;
          } catch {}
        }
        return ok(res, { canceled });
      }

      if (req.method === "POST" && seg === "exit-all") {
        if (!isAdmin(req)) return unauth(res);

        // 1) Cancel pendings first
        try {
          const orders = await kc.getOrders();
          const pend = orders.filter(o => ["OPEN", "TRIGGER PENDING"].includes(o.status));
          for (const o of pend) {
            try {
              try { await kc.cancelOrder(o.variety || "regular", o.order_id); }
              catch { await kc.cancelOrder(o.order_id, o.variety || "regular"); }
            } catch {}
          }
        } catch {}

        // 2) Square off net positions
        const pos = await kc.getPositions(); // { day:[], net:[] }
        const net = pos?.net || [];
        let squared_off = 0;
        for (const p of net) {
          const qty = Number(p.quantity ?? p.net_quantity ?? 0);
          if (!qty) continue;
          const side = qty > 0 ? "SELL" : "BUY";
          const absQty = Math.abs(qty);
          try {
            await kc.placeOrder("regular", {
              exchange: p.exchange || "NSE",
              tradingsymbol: p.tradingsymbol,
              transaction_type: side,
              quantity: absQty,
              product: p.product || "MIS",
              order_type: "MARKET",
              validity: "DAY"
            });
            squared_off++;
          } catch {}
        }
        return ok(res, { squared_off });
      }

      return nope(res);
    }

    // ------------------- ADMIN (WRITE) -------------------
    if (path.startsWith("/api/admin/")) {
      if (!isAdmin(req)) return unauth(res);
      const seg = path.replace("/api/admin/", "");
      const key = `risk:${todayKey()}`;
      const current = (await kv.get(key)) || {};

      if (req.method === "POST" && seg === "rules-set") {
        const body = req.body || {};
        const next = { ...current };
        [
          "max_loss_pct", "trail_step_profit", "cooldown_min",
          "max_consecutive_losses", "allow_new_after_lock10",
          "expiry_flag", "week_max_loss_pct", "month_max_loss_pct"
        ].forEach(k => {
          if (body[k] !== undefined) next[k] = body[k];
        });
        await kv.set(key, next);
        return ok(res, { saved: true });
      }

      if (req.method === "POST" && seg === "kill") {
        const next = { ...current, tripped_day: true, block_new_orders: true };
        await kv.set(key, next);
        return ok(res, { message: "Day killed. New orders blocked." });
      }

      if (req.method === "POST" && seg === "unlock") {
        const next = { ...current, block_new_orders: false };
        await kv.set(key, next);
        return ok(res, { message: "New orders allowed (per rules)." });
      }

      return nope(res);
    }

    // ------------------- GUARDIAN CRON -------------------
    if (path === "/api/guardian") {
      // Placeholder tick; you can extend with PnL calc + enforcement
      return ok(res, { tick: new Date().toISOString() });
    }

    return bad(res, "Unknown route");
  } catch (e) {
    return send(res, 500, { ok: false, error: e.message || String(e) });
  }
}
