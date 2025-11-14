// api/hub.js
// Single gateway for the UI -> kite & admin endpoints.

// Keep existing imports that your original hub needs; we've added auth/state imports.
import { instance as kiteInstance, loginUrl } from "./_lib/kite.js";
import { kv, todayKey } from "./_lib/kv.js";
import { isAdminFromReq, requireAdmin } from "./_lib/auth.js";
import { getState, setState } from "./_lib/state.js";

/* small response helpers */
function send(res, code, body = {}) {
  res.status(code).setHeader("Cache-Control", "no-store").json(body);
}
const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });
const nope = (res) => bad(res, "Method not allowed");
const unauth = (res) => requireAdmin(res);

/* Example kite helpers preserved if present in original hub - adapt if you had different ones */
async function safeInstance() {
  return await kiteInstance();
}

async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter((o) => o.status === "OPEN" || o.status === "TRIGGER PENDING");
    const outs = [];
    for (const p of pending) {
      try {
        await kc.cancelOrder(p.order_id);
        outs.push(p.order_id);
      } catch (e) {
        console.warn("cancelPending failed for", p.order_id, e && e.message ? e.message : e);
      }
    }
    return outs;
  } catch (e) {
    console.warn("cancelPending failed:", e && e.message ? e.message : e);
    return [];
  }
}

/* route dispatcher */
export default async function handler(req, res) {
  try {
    const url = req.url || req.path || (req.headers && (req.headers["x-now-route"] || req.headers["x-vercel-path"])) || "";

    // Central admin guard for /api/admin/*
    if (url.startsWith("/api/admin/") && !isAdminFromReq(req)) {
      return requireAdmin(res);
    }

    // Delegate kite/trades to the existing handler (keeps detailed logic in separate file)
    if (url.startsWith("/api/kite/trades")) {
      const tradesHandler = (await import("./kite/trades.js")).default;
      return tradesHandler(req, res);
    }

    // Delegate kite/funds if present
    if (url.startsWith("/api/kite/funds")) {
      const fundsHandler = (await import("./kite/funds.js")).default;
      return fundsHandler(req, res);
    }

    // Admin specific endpoints: keep separated files but protected by hub
    if (url.startsWith("/api/admin/set-config")) {
      const handlerFile = (await import("./admin/set-config.js")).default;
      return handlerFile(req, res);
    }
    if (url.startsWith("/api/admin/set-capital")) {
      const handlerFile = (await import("./admin/set-capital.js")).default;
      return handlerFile(req, res);
    }

    // Guardian / state read
    if (url.startsWith("/api/guardian") || url.startsWith("/api/state")) {
      const state = await getState();
      return ok(res, { state });
    }

    // Fallback: not found
    return send(res, 404, { ok: false, error: "not_found" });

  } catch (e) {
    console.error("hub error", e && e.stack ? e.stack : e);
    return send(res, 500, { ok: false, error: "server_error" });
  }
}
