// ==============================
// FINAL hub.js with GLOBAL CONFIG
// ==============================
// GLOBAL CONFIG stored in:   risk:config:global
// DAILY STATE stored in:     risk:YYYY-MM-DD
// ==============================

import { instance as kiteInstance } from "./_lib/kite.js";
import {
  kv,
  todayKey,
  getState as kvGetState,
  setState as kvSetState,
  _rawGet,
  _rawSet,
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
    res.setHeader(
      "Access-Control-Allow-Origin",
      "https://www.boho.trading"
    );
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
// JSON BODY PARSER
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

// DAILY state
async function loadDaily() {
  return (await kvGetState(todayKey())) || {};
}

async function saveDaily(obj) {
  return await kvSetState(todayKey(), obj);
}

// TRADEBOOK
async function loadTradebook() {
  return (await kv.get("guardian:tradebook")) || [];
}

async function saveTradebook(tb) {
  return await kv.set("guardian:tradebook", tb);
}

// ==============================
// GLOBAL CONFIG HELPERS
// ==============================

async function loadGlobalConfig() {
  return (await _rawGet("risk:config:global")) || {};
}

async function saveGlobalConfig(cfg) {
  return await _rawSet("risk:config:global", cfg);
}

// ==============================
// Zerodha Helpers
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
// GET /api/risk-status
// ==============================
// returns merged GLOBAL config + DAILY state

async function handleGetRiskStatus(req, res) {
  const daily = await loadDaily();
  const config = await loadGlobalConfig();

  const merged = {
    ...config,
    ...daily,
  };

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, state: merged }));
}

// ==============================
// GET /api/risk-config
// ==============================

async function handleGetRiskConfig(req, res) {
  const cfg = await loadGlobalConfig();

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, config: cfg }));
}

// ==============================
// GET /api/logs (simple MTM logs only)
// ==============================

async function handleGetLogs(req, res) {
  const daily = await loadDaily();
  const mtm = daily.mtm_log || [];

  const limit = Number(
    new URL(req.url, "http://localhost").searchParams.get("limit") || 50
  );

  const logs = mtm.map((m) => ({
    time: m.ts,
    type: "MTM",
    value: m.total,
  }));

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, logs: logs.slice(-limit) }));
}

// ==============================
// GET /api/trades
// ==============================

async function handleGetTrades(req, res) {
  const limit = Number(
    new URL(req.url, "http://localhost").searchParams.get("limit") || 100
  );

  // 🔥 READ FROM ACTUAL SOURCE OF TRUTH
  const tb = (await kv.get("guardian:tradebook")) || [];

  const trades = (Array.isArray(tb) ? tb : Object.values(tb))
    .map(t => ({
      ts: Number(t.ts ?? t._ts ?? t.raw?._ts),
      iso_date:
        t.iso_date ??
        t.raw?.exchange_timestamp ??
        (ts ? new Date(ts).toISOString() : null),

      tradingsymbol: t.tradingsymbol ?? t.raw?.tradingsymbol,
      side: t.side ?? t.transaction_type ?? t.raw?.transaction_type,
      qty: Number(t.qty ?? t.quantity ?? t.raw?.quantity),
      price: Number(t.price ?? t.average_price ?? t.raw?.average_price),
      trade_id: t.trade_id ?? t.raw?.trade_id,
    }))
    .filter(t => t.ts && t.tradingsymbol)
    .sort((a, b) => b.ts - a.ts)
    .slice(0, limit);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(trades));
}

// ==============================
// PUT /api/risk-config  (GLOBAL CONFIG UPDATE)
// ==============================

async function handlePutRiskConfig(req, res) {
  if (!requireAdmin(req, res)) return;

  const body = await readJsonBody(req);
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    res.statusCode = 400;
    return res.end(
      JSON.stringify({ ok: false, detail: "Invalid JSON body" })
    );
  }

  const allowedKeys = [
    "capital_day_915",
    "max_loss_pct",
    "max_loss_abs",
    "max_profit_pct",
    "max_profit_abs",
    "min_loss_to_count",
    "trail_step_profit",
    "cooldown_min",
    "cooldown_on_profit",
    "max_consecutive_losses",
    "allow_new",
    "block_new_orders",
    "max_trades_per_day",
    "side_lock",
  ];

  const current = await loadGlobalConfig();
  const patch = {};

  for (const key of allowedKeys) {
    if (key in body) patch[key] = body[key];
  }

  const finalConfig = { ...current, ...patch };
  await saveGlobalConfig(finalConfig);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, config: finalConfig }));
}

// ==============================
// POST /api/risk-config  (DISABLED)
// ==============================

async function handlePostRiskConfig(req, res) {
  res.statusCode = 405;
  res.setHeader("Content-Type", "application/json");
  res.end(
    JSON.stringify({
      ok: false,
      detail: "POST /api/risk-config disabled — use PUT",
    })
  );
}

// ==============================
// POST /api/reset-day
// ==============================
function stripNumericKeys(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj || {})) {
    if (!/^\d+$/.test(k)) {
      out[k] = v;
    }
  }
  return out;
}


async function handlePostResetDay(req, res) {
  if (!requireAdmin(req, res)) return;

  const daily = await loadDaily();

  const resetEntry = {
    time: Date.now(),
    reason: "manual_reset",
  };

 const base = stripNumericKeys(daily);

const cleared = {
  ...base,

  // 🔥 RESET CORE PNL
  realised: 0,
  unrealised: 0,
  total_pnl: 0,
  realised_history: [],
  mtm_log: [],

  // 🔥 POSITION / TRADE STATE
  last_net_positions: {},
  last_trade_time: 0,

  // 🔥 RISK STATE
  consecutive_losses: 0,
  cooldown_active: false,
  cooldown_until: 0,
  peak_profit: 0,
  active_loss_floor: 0,

  // 🔥 DAY FLAGS
  tripped_day: false,
  trip_reason: null,
  freeze_mode: null,
  allowed_positions: null,

  // 🔥 AUDIT
  reset_logs: [...(base.reset_logs || []), resetEntry],
  last_reset_at: Date.now(),
};


  await saveDaily(cleared);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, detail: "day reset" }));
}

// ==============================
// POST /api/cancel
// ==============================
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
      } catch {}
    }
    return cancelled;
  } catch {
    return 0;
  }
}
async function handlePostCancel(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kc = await kiteInstance(); // IMPORTANT: awaited
    const cancelled = await cancelPending(kc);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, cancelled }));
  } catch (e) {
    res.statusCode = 200; // prevent 500
    res.end(JSON.stringify({ ok: false, error: "Kite not connected" }));
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
      } catch {}
    }
    return squared;
  } catch {
    return 0;
  }
}
async function handlePostKill(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kc = await kiteInstance();
    const cancelled = await cancelPending(kc);
    const squared = await squareOffAll(kc);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, cancelled, squared }));
  } catch (e) {
    res.statusCode = 200;
    res.end(JSON.stringify({ ok: false, error: "Kite not connected" }));
  }
}

// ==============================
// POST /api/admin/trip
// ==============================

async function handlePostAdminTrip(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    // 1. Get kite safely
    const kc = await kiteInstance();

    // 2. Mechanical actions FIRST
    const cancelled = await cancelPending(kc);
    const squared = await squareOffAll(kc);

    // 3. Trip state AFTER positions are clean
    const key = `risk:${todayKey()}`;
    const cur = (await kv.get(key)) || {};

    const next = {
      ...cur,
      tripped_day: true,
      block_new_orders: true,
      last_enforced_at: Date.now(),
      enforcement_meta: {
        by: "admin",
        reason: "manual_trip"
      }
    };

    await kv.set(key, next);

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({
      ok: true,
      cancelled,
      squared,
      state: {
        tripped_day: true,
        block_new_orders: true
      }
    }));
  } catch (err) {
    // IMPORTANT: do not 500 unless truly fatal
    res.statusCode = 200;
    res.end(JSON.stringify({
      ok: false,
      error: "Trip failed",
      detail: err.message
    }));
  }
}



// ==============================
// POST /api/sync-kv-state
// ==============================

async function handlePostSyncKvState(req, res) {
  if (!requireAdmin(req, res)) return;

  const incoming = await readJsonBody(req);
  const daily = await loadDaily();

  const merged = {
    ...daily,
    ...incoming,

    mtm_log: [...(daily.mtm_log || []), ...(incoming.mtm_log || [])],
    reset_logs: [...(daily.reset_logs || []), ...(incoming.reset_logs || [])],
    config_logs: [...(daily.config_logs || []), ...(incoming.config_logs || [])],
  };

  await saveDaily(merged);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, synced_at: Date.now() }));
}

// ==============================
// ROUTER
// ==============================

export default async function handler(req, res) {
  if (applyCors(req, res)) return;

  const url = req.url || "";
  const method = req.method;

  // GET
  if (method === "GET" && url.startsWith("/api/risk-status"))
    return handleGetRiskStatus(req, res);
  if (method === "GET" && url.startsWith("/api/risk-config"))
    return handleGetRiskConfig(req, res);
  if (method === "GET" && url.startsWith("/api/logs"))
    return handleGetLogs(req, res);
  if (method === "GET" && url.startsWith("/api/trades"))
    return handleGetTrades(req, res);

  // PUT
  if (method === "PUT" && url === "/api/risk-config")
    return handlePutRiskConfig(req, res);

  // POST
  if (method === "POST" && url.startsWith("/api/risk-config"))
    return handlePostRiskConfig(req, res);

  if (method === "POST" && url.startsWith("/api/reset-day"))
    return handlePostResetDay(req, res);

  if (method === "POST" && url.startsWith("/api/cancel"))
    return handlePostCancel(req, res);

  if (method === "POST" && url.startsWith("/api/kill"))
    return handlePostKill(req, res);

  if (method === "POST" && url.startsWith("/api/sync-kv-state"))
    return handlePostSyncKvState(req, res);

  
  if (method === "POST" && url === "/api/admin/trip")
  return handlePostAdminTrip(req, res);



  // 404
  res.statusCode = 404;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: false, detail: "Endpoint not found" }));
}
