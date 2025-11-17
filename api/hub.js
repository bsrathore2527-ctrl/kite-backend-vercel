// api/hub.js
 // Single gateway for the UI -> kite & admin endpoints.

 import { instance as kiteInstance, loginUrl } from "./_lib/kite.js";
 import { kv, todayKey } from "./_lib/kv.js";

 // ⭐ added import for shared kill function
 import killNow from "./_lib/kill.js";

 /* small response helpers */
 function send(res, code, body = {}) {
   res.status(code).setHeader("Cache-Control", "no-store").json(body);
 }
 const ok = (res, body = {}) => send(res, 200, { ok: true, ...body });
 const bad = (res, msg = "Bad request") => send(res, 400, { ok: false, error: msg });
 const nope = (res) => send(res, 405, { ok: false, error: "Method not allowed" });

 /* a tiny helper to know if request is from admin panel */
 function isAdmin(req) {
   const t = req.headers["x-admin-token"] || req.headers["authorization"] || "";
   const token = process.env.ADMIN_TOKEN || "";
   return t && token && (t === token || t === `Bearer ${token}`);
 }

 /* safe instance get */
 async function safeInstance() {
   try {
     const kc = await kiteInstance();
     return kc;
   } catch (e) {
     throw new Error("Kite connection failed: " + (e?.message || String(e)));
   }
 }

 /* === CANCEL & SQUARE-OFF LOGIC (ORIGINAL — kept exactly) === */

 async function cancelPending(kc) {
   try {
     const orders = await kc.getOrders();
     const pending = (orders || []).filter((o) => {
       const s = (o.status || "").toUpperCase();
       return s === "OPEN" || s.includes("TRIGGER");
     });
     let cancelled = 0;
     for (const o of pending) {
       try {
         const variety = o.variety || "regular";
         const id = o.order_id || o.orderId || o.id;
         if (!id) continue;
         await kc.cancelOrder(variety, id);
         cancelled++;
       } catch (e) {}
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
       try {
         const qty = Number(p.net_quantity ?? p.quantity ?? 0);
         if (!qty) continue;
         const side = qty > 0 ? "SELL" : "BUY";
         const absQty = Math.abs(qty);

         const tradingsymbol =
           p.tradingsymbol ||
           p.trading_symbol ||
           p.instrumentToken ||
           p.symbol;

         const exchange = p.exchange || p.exchange_code || "NSE";

         await kc.placeOrder("regular", {
           exchange,
           tradingsymbol,
           transaction_type: side,
           quantity: absQty,
           order_type: "MARKET",
           product: p.product || "MIS",
           validity: "DAY",
         });
         squared++;
       } catch (e) {}
     }

     return squared;
   } catch (e) {
     return 0;
   }
 }

 /* === ORIGINAL enforceShutdown (kept for safety, not removed) === */
 async function enforceShutdown(kc, meta = {}) {
   const cancelled = await cancelPending(kc);
   const squared = await squareOffAll(kc);

   const key = `risk:${todayKey()}`;
   const cur = (await kv.get(key)) || {};
   const next = {
     ...cur,
     tripped_day: true,
     last_enforced_at: Date.now(),
     enforcement_meta: meta,
   };
   await kv.set(key, next);

   return { cancelled, squared, state: next };
 }

 /* ==============================
    HUB ROUTER
 ============================== */

 export default async function handler(req, res) {
   const { method } = req;
   const url = new URL(req.url, "http://dummy"); // dummy base
   const path = url.pathname;

   try {
     if (path === "/api/ping") {
       return ok(res, {
         time: new Date().toLocaleTimeString("en-IN", { hour12: false }),
         admin: isAdmin(req),
         kite_status: "unknown",
       });
     }

     if (path === "/api/state") {
       if (method !== "GET") return nope(res);
       const key = `risk:${todayKey()}`;
       const state = (await kv.get(key)) || {};
       return ok(res, {
         state,
         time: new Date().toLocaleTimeString("en-IN", {
           timeZone: "Asia/Kolkata",
           hour12: false,
         }),
         admin: isAdmin(req),
         kite_status: "unknown",
       });
     }

     if (path === "/api/kite/login") {
       try {
         const u = loginUrl();
         return ok(res, { url: u });
       } catch (e) {
         return send(res, 500, { ok: false, error: String(e) });
       }
     }

     /* ===========================
         ADMIN routes start
        =========================== */

     if (path.startsWith("/api/admin")) {
       if (!isAdmin(req))
         return send(res, 403, { ok: false, error: "Unauthorized" });

       const seg = path.replace(/^\/api\/admin\/?/, "").replace(/\/$/, "");

       // set-capital
       if (seg === "set-capital") {
         const body = await req.json();
         const key = `risk:${todayKey()}`;
         const cur = (await kv.get(key)) || {};
         const next = { ...cur, capital_day_915: body.capital };
         await kv.set(key, next);
         return ok(res, { saved: true, state: next });
       }

       // set-config
       if (seg === "set-config") {
         const body = await req.json();
         const key = `risk:${todayKey()}`;
         const cur = (await kv.get(key)) || {};
         const next = { ...cur, ...body };
         await kv.set(key, next);
         return ok(res, { saved: true, state: next });
       }

       // cancel only
       if (seg === "cancel") {
         const kc = await safeInstance();
         const cancelled = await cancelPending(kc);
         return ok(res, { cancelled });
       }

       /* ⭐ PATCHED KILL ROUTE — now uses shared killNow() */
       if (seg === "kill" || seg === "kill-all") {
         try {
           const kc = await safeInstance();
           const r = await killNow({
             kc,
             meta: { by: "admin_kill", time: Date.now() },
           });
           return ok(res, r);
         } catch (e) {
           return send(res, 200, {
             ok: false,
             error: "Kite not connected",
             message: e.message || String(e),
           });
         }
       }

       return send(res, 404, {
         ok: false,
         error: "Admin endpoint not found",
       });
     }

     return send(res, 404, { ok: false, error: "Not found" });
   } catch (err) {
     console.error("hub error:", err);
     return send(res, 500, {
       ok: false,
       error: err.message || String(err),
     });
   }
 }
