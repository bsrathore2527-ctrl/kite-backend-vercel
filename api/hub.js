// api/hub.js
// Single gateway for the UI -> kite & admin endpoints.

import { instance as kiteInstance, loginUrl } from "./_lib/kite.js";
import { kv, todayKey, getState as kvGetState, setState as kvSetState } from "./_lib/kv.js";

/* small response helpers */
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });
const nope = (res) => bad(res, "Method not allowed");
const unauth = (res) => send(res, 401, { ok: false, error: "Unauthorized" });

/* admin check: expects Authorization: Bearer <ADMIN_TOKEN> */
function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : a;
  return token && process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

/* Kite helpers */
async function safeInstance() {
  // Creates/returns kite instance (throws if can't connect)
  return await kiteInstance();
}

async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER");
    });
    let cancelled = 0;
    for (const o of pending) {
      try {
        await kc.cancelOrder(o.variety || "regular", o.order_id);
        cancelled++;
      } catch (e) {
        // ignore per-order failure
      }
    }
    return cancelled;
  } catch (e) {
    return 0;
  }
}

async function squareOffAll(kc) {
  try {
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let squared = 0;
    for (const p of net) {
      const qty = Number(p.net_quantity ?? p.quantity ?? 0);
      if (!qty) continue;
      const side = qty > 0 ? "SELL" : "BUY";
      const absQty = Math.abs(qty);
      try {
        await kc.placeOrder("regular", {
          exchange: p.exchange || "NSE",
          tradingsymbol: p.tradingsymbol || p.trading_symbol,
          transaction_type: side,
          quantity: absQty,
          order_type: "MARKET",
          product: p.product || "MIS",
          validity: "DAY"
        });
        squared++;
      } catch (e) {
        // ignore per-symbol failure
      }
    }
    return squared;
  } catch (e) {
    return 0;
  }
}

/* administrative enforcement: cancel pending + square-off + mark state */
async function enforceShutdown(kc, meta = {}) {
  const cancelled = await cancelPending(kc);
  const squared = await squareOffAll(kc);
  const key = `risk:${todayKey()}`;
  const cur = (await kv.get(key)) || {};
  const next = { ...cur, tripped_day: true, last_enforced_at: Date.now(), enforcement_meta: meta };
  await kv.set(key, next);
  return { cancelled, squared, state: next };
}

/* serve request */
export default async function handler(req, res) {
  try {
    const url = new URL(req.url, "http://x"); // base doesn't matter
    const path = url.pathname;
    const method = req.method || "GET";

    // === /api/login -> redirect to Zerodha login page ===
    if (path === "/api/login") {
      if (method !== "GET") return nope(res);
      try {
        const u = loginUrl();
        // prefer redirect to open in browser; UI might also use fetch to get URL.
        res.writeHead(302, { Location: u });
        return res.end();
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message || String(e) });
      }
    }

    // === /api/state -> returns stored state (from kv) ===
    if (path === "/api/state") {
      if (method !== "GET") return nope(res);
      try {
        const key = `risk:${todayKey()}`;
        const state = (await kv.get(key)) || {};
        return ok(res, { state, time: new Date().toLocaleTimeString("en-IN", { timeZone: "Asia/Kolkata", hour12: false }), admin: isAdmin(req), kite_status: "unknown" });
      } catch (e) {
        return send(res, 500, { ok: false, error: e.message || String(e) });
      }
    }

    // === /api/kite/* endpoints (public + admin actions) ===
    if (path.startsWith("/api/kite")) {
      const seg = path.replace(/^\/api\/kite\/?/, "").replace(/\/$/, "");
      // /api/kite/login - return login URL when called via GET, or POST allowed too
      if (seg === "login" || path === "/api/kite/login") {
        if (method === "GET") {
          try {
            const u = loginUrl();
            return ok(res, { url: u });
          } catch (e) { return send(res, 500, { ok:false, error: String(e) }); }
        }
        // if UI POSTs, allow it as well and return url
        if (method === "POST") {
          try {
            const u = loginUrl();
            return ok(res, { url: u });
          } catch (e) { return send(res, 500, { ok:false, error: String(e) }); }
        }
        return nope(res);
      }

      // /api/kite/funds - try to get funds via kite instance (GET)
      if (seg === "funds" || path === "/api/kite/funds") {
        if (method !== "GET") return nope(res);
        try {
          const kc = await safeInstance();
          const funds = await kc.getFunds();
          return ok(res, { funds });
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // /api/kite/positions
      if (seg === "positions" || path === "/api/kite/positions") {
        if (method !== "GET") return nope(res);
        try {
          const kc = await safeInstance();
          const positions = await kc.getPositions();
          return ok(res, { positions });
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // admin-style kite actions that require a connected kite instance:
      // cancel-all, exit-all (POST)
      if (seg === "cancel-all" || seg === "cancel_all" || seg === "cancelorders" || seg === "cancel-orders") {
        if (method !== "POST") return nope(res);
        try {
          const kc = await safeInstance();
          const cancelled = await cancelPending(kc);
          return ok(res, { cancelled });
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      if (seg === "exit-all" || seg === "square-off" || seg === "exit_all" || seg === "square_off") {
        if (method !== "POST") return nope(res);
        try {
          const kc = await safeInstance();
          const squared = await squareOffAll(kc);
          return ok(res, { squared });
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // if not matched, return not found to avoid accidental 405s
      return send(res, 404, { ok: false, error: "Not found" });
    }

    // === /api/admin/* endpoints (require admin token) ===
    if (path.startsWith("/api/admin")) {
      const seg = path.replace(/^\/api\/admin\/?/, "").replace(/\/$/, "");
      if (!isAdmin(req)) return unauth(res);

      // /api/admin/enforce -> cancel pending and square-off, mark tripped
      if (seg === "enforce" || seg === "enforce-now") {
        if (method !== "POST" && method !== "GET") return nope(res);
        try {
          const kc = await safeInstance();
          const r = await enforceShutdown(kc, { by: "admin", time: Date.now() });
          return ok(res, r);
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // /api/admin/cancel -> cancel pending orders
      if (seg === "cancel" || seg === "cancel_all" || seg === "cancel-all" || seg === "cancelOrders" || seg === "cancelOrdersAll") {
        if (method !== "POST") return nope(res);
        try {
          const kc = await safeInstance();
          const cancelled = await cancelPending(kc);
          return ok(res, { cancelled });
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // /api/admin/kill -> full enforcement (alias of enforce)
      if (seg === "kill" || seg === "kill-all") {
        if (method !== "POST" && method !== "GET") return nope(res);
        try {
          const kc = await safeInstance();
          const r = await enforceShutdown(kc, { by: "admin_kill", time: Date.now() });
          return ok(res, r);
        } catch (e) {
          return send(res, 200, { ok: false, error: "Kite not connected", message: e.message || String(e) });
        }
      }

      // /api/admin/unlock or /api/admin/allow -> clear block_new_orders
      if (seg === "unlock" || seg === "allow" || seg === "allow_new") {
        if (method !== "POST") return nope(res);
        try {
          const key = `risk:${todayKey()}`;
          const cur = (await kv.get(key)) || {};
          const next = { ...cur, block_new_orders: false };
          await kv.set(key, next);
          return ok(res, { state: next });
        } catch (e) {
          return send(res, 500, { ok: false, error: e.message || String(e) });
        }
      }

      // unknown admin endpoint
      return send(res, 404, { ok: false, error: "Admin endpoint not found" });
    }

    // nothing matched
    return send(res, 404, { ok: false, error: "Not found" });
  } catch (err) {
    console.error("hub error:", err);
    return send(res, 500, { ok: false, error: err.message || String(err) });
  }
      }
