// api/admin/[...slug].js
// Single admin router to consolidate multiple admin endpoints into one serverless function.
// Replace your other api/admin/*.js files with this single file to reduce Vercel function count.

import { kv, todayKey, setState, getState } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function parseJson(req) {
  try {
    if (typeof req.json === "function") return await req.json();
  } catch (e) {}
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    const txt = chunks.join("");
    if (!txt) return {};
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

// small helpers for kite enforcement actions (reused from your enforce.js)
async function cancelPending(kc) {
  try {
    const orders = await kc.getOrders();
    const pending = (orders || []).filter(o => {
      const s = (o.status || "").toUpperCase();
      return s === "OPEN" || s.includes("TRIGGER") || s === "PENDING";
    });
    let cancelled = 0;
    for (const o of pending) {
      try {
        await kc.cancelOrder(o.variety || "regular", o.order_id);
        cancelled++;
      } catch (e) { /* ignore per-order failures */ }
    }
    return cancelled;
  } catch (e) { return 0; }
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
      } catch (e) { /* ignore per-symbol failures */ }
    }
    return squared;
  } catch (e) { return 0; }
}

export default async function handler(req, res) {
  // Path routing
  // This file is mounted at /api/admin/[...slug].js
  // The path after /api/admin/ is available in req.query.slug (array) or req.url
  try {
    // quick method check
    const method = (req.method || "GET").toUpperCase();

    // parse the route slug
    // Vercel file-based dynamic catch-all gives slug in req.query.slug (array)
    // fallback to parsing URL if not present
    let slugParts = [];
    try { slugParts = req.query?.slug || []; } catch (e) { /* ignore */ }
    if (!Array.isArray(slugParts) || slugParts.length === 0) {
      // parse from path
      const url = req.url || "";
      const m = url.match(/\/api\/admin\/?(.*)/);
      if (m && m[1]) slugParts = m[1].split("/").filter(Boolean);
    }
    const route = (slugParts[0] || "").toLowerCase();

    // Authorization for admin-only routes
    const adminRequired = [
      "set-config","set-config.js","set-capital","set-capital.js","setcapital","set-captial",
      "kill","cancel","reset-day","resetday","setcapital","set_capital","enforce-trades"
    ];
    if (adminRequired.includes(route) && !isAdmin(req)) {
      return res.status(401).json({ ok:false, error: "unauthorized" });
    }

    // ROUTES ------------------------------------------------

    // POST /api/admin/set-config
    if (route === "set-config" && method === "POST") {
      const body = await parseJson(req);
      if (body === null) return res.status(400).json({ ok:false, error: "invalid json" });

      const patch = {};
      const toNum = v => {
        if (v === null || v === undefined || v === "") return undefined;
        const n = Number(v);
        return Number.isFinite(n) ? n : undefined;
      };

      if (typeof body.max_loss_pct !== "undefined") { const v = toNum(body.max_loss_pct); if (typeof v !== "undefined") patch.max_loss_pct = v; }
      if (typeof body.trail_step_profit !== "undefined") { const v = toNum(body.trail_step_profit); if (typeof v !== "undefined") patch.trail_step_profit = v; }
      if (typeof body.cooldown_min !== "undefined") { const v = toNum(body.cooldown_min); if (typeof v !== "undefined") patch.cooldown_min = v; }
      if (typeof body.max_consecutive_losses !== "undefined") { const v = toNum(body.max_consecutive_losses); if (typeof v !== "undefined") patch.max_consecutive_losses = v; }

      if (typeof body.p10_pct !== "undefined") { const v = toNum(body.p10_pct); if (typeof v !== "undefined") { patch.p10 = v; patch.p10_is_pct = true; } }
      else if (typeof body.p10 !== "undefined") { const v = toNum(body.p10); if (typeof v !== "undefined") { patch.p10 = v; patch.p10_is_pct = true; } }
      else if (typeof body.p10_amount !== "undefined") { const v = toNum(body.p10_amount); if (typeof v !== "undefined") { patch.p10_amount = v; patch.p10_is_pct = false; } }

      if (typeof body.admin_override_capital !== "undefined") patch.admin_override_capital = !!body.admin_override_capital;
      if (typeof body.capital_day_915 !== "undefined") { const v = toNum(body.capital_day_915); if (typeof v !== "undefined") patch.capital_day_915 = v; }

      if (typeof body.profit_lock_10 !== "undefined") patch.profit_lock_10 = !!body.profit_lock_10;
      if (typeof body.allow_new_after_lock10 !== "undefined") patch.allow_new_after_lock10 = !!body.allow_new_after_lock10;

      // behavioral & allow-new
      if (typeof body.cooldown_on_profit !== "undefined") patch.cooldown_on_profit = !!body.cooldown_on_profit;
      if (typeof body.min_loss_to_count !== "undefined") { const v = toNum(body.min_loss_to_count); if (typeof v !== "undefined") patch.min_loss_to_count = v; }
      if (typeof body.allow_new !== "undefined") { patch.allow_new = !!body.allow_new; patch.block_new_orders = !patch.allow_new; }

      // Inline reset-day
      if (body && body.reset_day === true) {
        try {
          const preserve = !!body.preserve_losses;
          const resetPatch = {
            tripped_day: false,
            tripped_week: false,
            tripped_month: false,
            block_new_orders: false,
            cooldown_until: 0,
            cooldown_active: false,
            trip_reason: null,
            last_reset_by: "admin",
            last_reset_at: Date.now(),
          };
          if (!preserve) resetPatch.consecutive_losses = 0;
          const updated = await setState(resetPatch);
          const key = `risk:${todayKey()}`;
          await kv.set(key, updated);
          return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, updated, note:"Day reset (inline)" });
        } catch (e) {
          console.error("reset-day inline error:", e && e.stack ? e.stack : e);
          return res.status(500).json({ ok:false, error: String(e) });
        }
      }

      if (Object.keys(patch).length === 0) return res.status(400).json({ ok:false, error: "missing fields" });
      try {
        const updated = await setState(patch);
        const key = `risk:${todayKey()}`;
        await kv.set(key, updated);
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, updated });
      } catch (e) {
        console.error("set-config error:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // POST /api/admin/set-capital
    if (["set-capital","setcapital","set_capital","set-captial"].includes(route) && method === "POST") {
      const body = await parseJson(req);
      if (body === null) return res.status(400).json({ ok:false, error: "invalid json" });
      const val = Number(body.capital ?? body.amount ?? body.value);
      if (!Number.isFinite(val)) return res.status(400).json({ ok:false, error: "invalid capital" });
      try {
        const updated = await setState({ capital_day_915: val, admin_override_capital: true });
        const key = `risk:${todayKey()}`;
        await kv.set(key, updated);
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, updated });
      } catch (e) {
        console.error("set-capital err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // POST /api/admin/cancel
    if (route === "cancel" && method === "POST") {
      try {
        const kc = await instance();
        const cancelled = await cancelPending(kc);
        await setState({ last_admin_cancel_at: Date.now() });
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, cancelled });
      } catch (e) {
        console.error("admin cancel err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // POST /api/admin/kill
    if (route === "kill" && method === "POST") {
      try {
        const kc = await instance();
        const cancelled = await cancelPending(kc);
        const squared = await squareOffAll(kc);
        await setState({ last_admin_kill_at: Date.now(), admin_last_kill_result: { cancelled, squared } });
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, cancelled, squared });
      } catch (e) {
        console.error("admin kill err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // GET or POST /api/admin/enforce  (UI calls GET sometimes)
    if (route === "enforce" && (method === "GET" || method === "POST")) {
      try {
        const kc = await instance();
        // fetch today's state to check if enforcement needed; but allow forced enforce
        const state = await getState();
        // proceed to cancel + square off
        const cancelled = await cancelPending(kc);
        const squared = await squareOffAll(kc);
        const next = { ...state, last_enforced_at: Date.now() };
        await kv.set(`risk:${todayKey()}`, next);
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, cancelled, squared });
      } catch (e) {
        console.error("admin enforce err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // POST /api/admin/reset-day
    if (route === "reset-day" && method === "POST") {
      const body = await parseJson(req);
      if (body === null) return res.status(400).json({ ok:false, error: "invalid json" });
      const preserve = !!body.preserve_losses;
      const resetPatch = {
        tripped_day: false,
        tripped_week: false,
        tripped_month: false,
        block_new_orders: false,
        cooldown_until: 0,
        cooldown_active: false,
        trip_reason: null,
        last_reset_by: "admin",
        last_reset_at: Date.now(),
      };
      if (!preserve) resetPatch.consecutive_losses = 0;
      try {
        const updated = await setState(resetPatch);
        const key = `risk:${todayKey()}`;
        await kv.set(key, updated);
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, updated, preserve_losses: preserve });
      } catch (e) {
        console.error("reset-day err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // POST /api/admin/enforce-trades -> light trigger (runs same processing as scheduled job may, but minimal)
    if (route === "enforce-trades" && method === "POST") {
      // best-effort: fetch trades via kite and return immediately
      try {
        const kc = await instance();
        const trades = await kc.getTrades();
        // just return trade count and last timestamp for admin to inspect
        const newestTs = Array.isArray(trades) && trades.length ? Math.max(...trades.map(t => Number(t.timestamp||t.trade_time||Date.now()))) : 0;
        return res.setHeader("Cache-Control","no-store").status(200).json({ ok:true, trades_count: Array.isArray(trades)?trades.length:0, newest_ts: newestTs });
      } catch (e) {
        console.error("admin enforce-trades err:", e && e.stack ? e.stack : e);
        return res.status(500).json({ ok:false, error: String(e) });
      }
    }

    // unknown admin route
    return res.status(404).json({ ok:false, error: "unknown admin route", route });
  } catch (err) {
    console.error("admin router error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
}
