// ==============================
// FINAL UNIFIED & CLEANED hub.js
// With Simple Logs (Option A)
// ==============================

import { instance as kiteInstance } from "./_lib/kite.js";
import {
  kv,
  todayKey,
  getState as kvGetState,
  setState as kvSetState,
} from "./_lib/kv.js";

// ==============================
// CORS
// ==============================

const allowedOrigins = [
  "https://boho.trading",
  "https://www.boho.trading",
  "https://bohoapp.com",
  "https://www.bohoapp.com",
  "https://api.bohoapp.com",
  "http://localhost:3000",
];

function applyCors(req, res) {
  const origin = req.headers.origin || "";

  if (allowedOrigins.includes(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
  } else {
    res.setHeader("Access-Control-Allow-Origin", "https://boho.trading");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, PUT, OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, x-admin-key");

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}

// ==============================
// ADMIN AUTH
// ==============================

const ADMIN_SECRET = process.env.ADMIN_SECRET;

function requireAdmin(req, res) {
  const key = req.headers["x-admin-key"];
  if (!ADMIN_SECRET || key !== ADMIN_SECRET) {
    res.statusCode = 401;
    res.end(JSON.stringify({ ok: false, detail: "Unauthorized" }));
    return false;
  }
  return true;
}

// ==============================
// JSON PARSER
// ==============================

async function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

// ==============================
// KV HELPERS
// ==============================

async function loadDaily() {
  return (await kvGetState(todayKey())) || {};
}

async function saveDaily(obj) {
  return await kvSetState(todayKey(), obj);
}

async function loadLive() {
  return (await kv.get("latest_kv_state")) || {};
}

async function saveLive(obj) {
  return await kv.set("latest_kv_state", obj);
}

async function loadGlobalConfig() {
  return (await kv.get("risk:config:global")) || {};
}

async function saveGlobalConfig(obj) {
  return await kv.set("risk:config:global", obj);
}

// ==============================
// GET: /api/risk-status
// ==============================

async function handleGetRiskStatus(req, res) {
  const live = await loadLive();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, state: live }));
}

// ==============================
// GET: /api/logs (simple MTM logs only)
// ==============================

async function handleGetLogs(req, res) {
  const daily = await loadDaily();
  const limit = Number(new URL(req.url, "http://localhost").searchParams.get("limit") || "50");
  const mtm = daily.mtm_log || [];

  const logs = mtm.map((m) => ({ time: m.ts, type: "MTM", value: m.total ?? 0 }));

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, logs: logs.slice(-limit) }));
}

// ==============================
// GET: /api/risk-config
// ==============================

async function handleGetRiskConfig(req, res) {
  const daily = await loadDaily();
  let config = {};

  if (daily && Object.keys(daily).length > 0) {
    config = {
      capital_day_915: daily.capital_day_915,
      max_loss_pct: daily.max_loss_pct,
      max_loss_abs: daily.max_loss_abs,
      max_profit_pct: daily.max_profit_pct,
      max_profit_abs: daily.max_profit_abs,
      trail_step_profit: daily.trail_step_profit,
      cooldown_min: daily.cooldown_min,
      min_loss_to_count: daily.min_loss_to_count,
      max_consecutive_losses: daily.max_consecutive_losses,
      cooldown_on_profit: daily.cooldown_on_profit,
      allow_new: daily.allow_new,
      block_new_orders: daily.block_new_orders,
      config_logs: daily.config_logs || [],
    };
  } else {
    config = await loadGlobalConfig();
  }

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, config }));
}

// ==============================
// GET: /api/trades
// ==============================

async function handleGetTrades(req, res) {
  const trades = (await kv.get("guardian:tradebook")) || [];
  const limit = Number(new URL(req.url, "http://localhost").searchParams.get("limit") || "100");

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, trades: trades.slice(-limit) }));
}

// ==============================
// PUT: /api/risk-config (GLOBAL CONFIG UPDATE)
// ==============================

async function handlePutRiskConfig(req, res) {
  const key = req.headers["x-admin-key"];
  if (!key || key !== ADMIN_SECRET) {
    res.statusCode = 401;
    return res.end(JSON.stringify({ ok: false, detail: "Unauthorized" }));
  }

  let body = "";
  await new Promise((resolve) => {
    req.on("data", (chunk) => (body += chunk));
    req.on("end", resolve);
  });

  let patch = {};
  try {
    patch = JSON.parse(body);
  } catch {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, detail: "Invalid JSON" }));
  }

  const current = (await kv.get("risk:config:global")) || {};
  const updated = { ...current, ...patch };
  await kv.set("risk:config:global", updated);

  res.statusCode = 200;
  res.end(JSON.stringify({ ok: true, config: updated }));
}

// ==============================
// POST: /api/risk-config (DAILY CONFIG UPDATE)
// ==============================

async function handlePostRiskConfig(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = await readJsonBody(req);
  const daily = await loadDaily();
  const live = await loadLive();

  const patch = {
    capital_day_915: body.capital_day_915 ?? daily.capital_day_915,
    max_loss_pct: body.max_loss_pct ?? daily.max_loss_pct,
    max_profit_pct: body.max_profit_pct ?? daily.max_profit_pct,
    max_loss_abs: body.max_loss_abs ?? daily.max_loss_abs,
    max_profit_abs: body.max_profit_abs ?? daily.max_profit_abs,
    trail_step_profit: body.trail_step_profit ?? daily.trail_step_profit,
    cooldown_min: body.cooldown_min ?? daily.cooldown_min,
    cooldown_on_profit: body.cooldown_on_profit ?? daily.cooldown_on_profit,
    min_loss_to_count: body.min_loss_to_count ?? daily.min_loss_to_count,
    max_consecutive_losses: body.max_consecutive_losses ?? daily.max_consecutive_losses,
    allow_new: body.allow_new ?? daily.allow_new,
  };

  const logEntry = { time: Date.now(), patch };

  const updatedDaily = {
    ...daily,
    ...patch,
    config_logs: [...(daily.config_logs || []), logEntry],
  };

  const updatedLive = {
    ...live,
    ...patch,
    config_logs: [...(live.config_logs || []), logEntry],
  };

  await saveDaily(updatedDaily);
  await saveLive(updatedLive);
  await saveGlobalConfig(updatedLive);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, detail: "config updated" }));
}

// ==============================
// POST: /api/reset-day
// ==============================

async function handlePostResetDay(req,


// ==============================
// Zerodha Helpers (Option 1)
// ==============================

async function kiteGet(kite, path) {
  const res = await kite.get(path);
  if (!res || !res.data) throw new Error("Invalid kite GET response");
  return res;
}

async function kitePost(kite, path, body) {
  const res = await kite.post(path, body);
  if (!res || !res.data) throw new Error("Invalid kite POST response");
  return res;
}

// ==============================
// POST: /api/reset-day
// ==============================

async function handlePostResetDay(req, res) {
  if (!requireAdmin(req, res)) return;

  const daily = await loadDaily();
  const live = await loadLive();

  const resetEntry = { time: Date.now(), reason: "manual_reset" };

  const cleared = {
    ...daily,
    realised: 0,
    unrealised: 0,
    total_pnl: 0,
    realised_history: [],
    mtm_log: [],
    last_net_positions: {},
    last_trade_time: 0,
    consecutive_losses: 0,
    cooldown_active: false,
    cooldown_until: 0,
    peak_profit: 0,
    block_new_orders: false,
    freeze_mode: null,
    allowed_positions: null,
    tripped_day: false,
    trip_reason: null,
    reset_logs: [...(daily.reset_logs || []), resetEntry],
  };

  await saveDaily(cleared);
  await saveLive(cleared);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, detail: "day reset" }));
}

// ==============================
// POST: /api/cancel
// ==============================

async function handlePostCancel(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kite = kiteInstance();
    const orders = await kiteGet(kite, "/orders");

    const pending = orders.data.filter(
      (o) => o.status === "OPEN" || o.status === "TRIGGER PENDING"
    );

    for (const o of pending) {
      await kitePost(kite, "/orders/cancel", { order_id: o.order_id });
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, cancelled: pending.length }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// ==============================
// POST: /api/kill
// ==============================

async function handlePostKill(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kite = kiteInstance();

    const orders = await kiteGet(kite, "/orders");
    const pending = orders.data.filter(
      (o) => o.status === "OPEN" || o.status === "TRIGGER PENDING"
    );

    for (const o of pending) {
      await kitePost(kite, "/orders/cancel", { order_id: o.order_id });
    }

    const positions = await kiteGet(kite, "/portfolio/positions");
    const net = positions.data.net || [];

    let squared = 0;

    for (const pos of net) {
      if (pos.quantity === 0) continue;

      const side = pos.quantity > 0 ? "SELL" : "BUY";
      const qty = Math.abs(pos.quantity);

      await kitePost(kite, "/orders/place", {
        exchange: pos.exchange,
        tradingsymbol: pos.tradingsymbol,
        transaction_type: side,
        quantity: qty,
        product: pos.product,
        order_type: "MARKET",
      });

      squared++;
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      cancelled: pending.length,
      squared,
    }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}

// ==============================
// POST: /api/sync-kv-state
// ==============================

async function handlePostSyncKvState(req, res) {
  if (!requireAdmin(req, res)) return;

  const incoming = await readJsonBody(req);
  if (typeof incoming !== "object") {
    res.statusCode = 400;
    return res.end(JSON.stringify({ ok: false, detail: "Invalid JSON" }));
  }

  const prev = await loadLive();
  const tradebook = (await kv.get("guardian:tradebook")) || [];

  const merged = {
    ...prev,
    ...incoming,
    mtm_log: [...(prev.mtm_log || []), ...(incoming.mtm_log || [])],
    config_logs: [...(prev.config_logs || []), ...(incoming.config_logs || [])],
    reset_logs: [...(prev.reset_logs || []), ...(incoming.reset_logs || [])],
    enforce_logs: [...(prev.enforce_logs || []), ...(incoming.enforce_logs || [])],
    connection_logs: [...(prev.connection_logs || []), ...(incoming.connection_logs || [])],
    last_tradebook_count: Array.isArray(tradebook) ? tradebook.length : 0,
    synced_at: Date.now(),
  };

  await saveLive(merged);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, synced_at: merged.synced_at }));
}

// ==============================
// ROUTER
// ==============================

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const url = req.url || "";
  const method = req.method;

  if (method === "GET" && url.startsWith("/api/risk-status")) return handleGetRiskStatus(req, res);
  if (method === "GET" && url.startsWith("/api/risk-config")) return handleGetRiskConfig(req, res);
  if (method === "GET" && url.startsWith("/api/logs")) return handleGetLogs(req, res);
  if (method === "GET" && url.startsWith("/api/trades")) return handleGetTrades(req, res);

  if (method === "PUT" && url === "/api/risk-config") return handlePutRiskConfig(req, res);

  if (method === "POST" && url.startsWith("/api/risk-config")) return handlePostRiskConfig(req, res);
  if (method === "POST" && url.startsWith("/api/reset-day")) return handlePostResetDay(req, res);
  if (method === "POST" && url.startsWith("/api/cancel")) return handlePostCancel(req, res);
  if (method === "POST" && url.startsWith("/api/kill")) return handlePostKill(req, res);
  if (method === "POST" && url.startsWith("/api/sync-kv-state")) return handlePostSyncKvState(req, res);

  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, detail: "Endpoint not found" }));
}
