// ==============================
//  PART 1 — IMPORTS & CORE SETUP
//  (Matches original hub.js structure)
// ==============================

// ⚠ Your original hub.js uses these paths and structure:
import { instance as kiteInstance, loginUrl } from "./_lib/kite.js";
import {
  kv,
  todayKey,
  getState as kvGetState,
  setState as kvSetState,
} from "./_lib/kv.js";

// ==============================
//  CORS CONFIG — STRICT (NO VERCEL PREVIEW)
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
    // default – allow only main domain (strict)
    res.setHeader("Access-Control-Allow-Origin", "https://boho.trading");
  }

  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader(
    "Access-Control-Allow-Headers",
    "Content-Type, x-admin-key"
  );

  if (req.method === "OPTIONS") {
    res.statusCode = 200;
    res.end();
    return true;
  }
  return false;
}

// ==============================
//  ADMIN SECURITY (x-admin-key)
//  Replaces old Authorization: Bearer
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
//  JSON BODY PARSER (Original hub.js compatible)
// ==============================
async function readJsonBody(req) {
  return new Promise((resolve) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(JSON.parse(body || "{}"));
      } catch (err) {
        resolve({});
      }
    });
  });
}

// ==============================
//  KV HELPERS — matches your old style
// ==============================

// Loads today's risk:YYYY-MM-DD snapshot
async function loadDaily() {
  return (await kvGetState(todayKey())) || {};
}

// Saves today's risk:YYYY-MM-DD snapshot
async function saveDaily(obj) {
  return await kvSetState(todayKey(), obj);
}

// Loads merged risk-engine state (live)
async function loadLive() {
  return (await kv.get("latest_kv_state")) || {};
}

// Saves merged live state
async function saveLive(obj) {
  return await kv.set("latest_kv_state", obj);
}

// Loads global config (default)
async function loadGlobalConfig() {
  return (await kv.get("risk:config:global")) || {};
}

// Saves global config (default)
async function saveGlobalConfig(obj) {
  return await kv.set("risk:config:global", obj);
}
// ==============================
//  PART 2 — PUBLIC GET ENDPOINTS
// ==============================

async function handleGetRiskStatus(req, res) {
  const live = await loadLive();
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, state: live }));
}
async function handleGetLogs(req, res) {
  const daily = await loadDaily();

  const limit = Number(
    new URL(req.url, "http://localhost").searchParams.get("limit") || "50"
  );

  const mtm = daily.mtm_log || [];

  const normalized = mtm.map(m => ({
    time: m.ts,
    type: "MTM",
    value: m.total ?? 0
  }));

  const trimmed = normalized.slice(-limit);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, logs: trimmed }));
}


async function handleGetRiskConfig(req, res) {
  // Try today's snapshot first
  const daily = await loadDaily();

  let config = {};

  if (daily && Object.keys(daily).length > 0) {
    // Extract config fields from daily snapshot
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
    // Load global config (fallback)
    const global = await loadGlobalConfig();
    config = global || {};
  }

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, config }));
}



async function handleGetTrades(req, res) {
  const tradebook = (await kv.get("guardian:tradebook")) || [];

  const limit = Number(
    new URL(req.url, "http://localhost").searchParams.get("limit") || "100"
  );

  const trimmed = tradebook.slice(-limit);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, trades: trimmed }));
}
// ==============================
//  PART 3 — ADMIN-PROTECTED POST ENDPOINTS
// ==============================

// -------------------------------------
//  POST /api/risk-config
//  (Replaces old set-config.js)
// -------------------------------------
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

  // Append config log entry
  const configLogEntry = {
    time: Date.now(),
    patch: patch,
  };

  const updatedDaily = {
    ...daily,
    ...patch,
    config_logs: [...(daily.config_logs || []), configLogEntry],
  };

  const updatedLive = {
    ...live,
    ...patch,
    config_logs: [...(live.config_logs || []), configLogEntry],
  };

  await saveDaily(updatedDaily);
  await saveLive(updatedLive);
  await saveGlobalConfig(updatedLive); // global defaults updated also

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, detail: "config updated" }));
}


// -------------------------------------
//  POST /api/reset-day
// -------------------------------------
async function handlePostResetDay(req, res) {
  if (!requireAdmin(req, res)) return;

  const daily = await loadDaily();
  const live = await loadLive();

  const resetEntry = {
    time: Date.now(),
    reason: "manual_reset",
  };

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


// -------------------------------------
//  POST /api/cancel
//  (Cancel all pending orders via Zerodha)
// -------------------------------------
async function handlePostCancel(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kite = kiteInstance();
    const orders = await kiteGet(kite, "/orders");

    const pending = orders.data.filter(
      (o) => o.status === "OPEN" || o.status === "TRIGGER PENDING"
    );

    for (const o of pending) {
      await kitePost(kite, `/orders/cancel`, { order_id: o.order_id });
    }

    res.setHeader("Content-Type", "application/json");
    res.end(JSON.stringify({ ok: true, cancelled: pending.length }));
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}


// -------------------------------------
//  POST /api/kill
//  Cancel all -> square off all positions
// -------------------------------------
async function handlePostKill(req, res) {
  if (!requireAdmin(req, res)) return;

  try {
    const kite = kiteInstance();

    // 1️⃣ CANCEL ALL PENDING ORDERS
    const orders = await kiteGet(kite, "/orders");
    const pending = orders.data.filter(
      (o) => o.status === "OPEN" || o.status === "TRIGGER PENDING"
    );

    for (const o of pending) {
      await kitePost(kite, `/orders/cancel`, { order_id: o.order_id });
    }

    // 2️⃣ SQUARE OFF ALL POSITIONS
    const positions = await kiteGet(kite, "/portfolio/positions");
    const net = positions.data.net || [];

    let squared = 0;

    for (const pos of net) {
      if (pos.quantity === 0) continue;

      const side = pos.quantity > 0 ? "SELL" : "BUY";
      const qty = Math.abs(pos.quantity);

      await kitePost(kite, `/orders/place`, {
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
    res.end(
      JSON.stringify({
        ok: true,
        cancelled: pending.length,
        squared,
      })
    );
  } catch (err) {
    res.statusCode = 500;
    res.end(JSON.stringify({ ok: false, error: err.message }));
  }
}


// -------------------------------------
//  POST /api/sync-kv-state
//  (Risk engine pushes incremental updates)
// -------------------------------------
async function handlePostSyncKvState(req, res) {
  if (!requireAdmin(req, res)) return;

  const incoming = await readJsonBody(req);
  if (typeof incoming !== "object") {
    res.statusCode = 400;
    res.end(JSON.stringify({ ok: false, detail: "Invalid JSON" }));
    return;
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

    admin_last_enforce_result:
      incoming.admin_last_enforce_result ??
      prev.admin_last_enforce_result ??
      null,

    last_tradebook_count: Array.isArray(tradebook)
      ? tradebook.length
      : 0,

    synced_at: Date.now(),
  };

  await saveLive(merged);

  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify({ ok: true, synced_at: merged.synced_at }));
}
// ==============================
//  PART 4 — ROUTER + FINAL EXPORT
//  (Merge new endpoints with original hub.js behavior)
// ==============================

export default async function handler(req, res) {
  // Apply CORS (OPTIONS handled here)
  if (applyCors(req, res)) return;

  const url = req.url || "";
  const method = req.method;

  // ============================
  //  NEW GET ENDPOINTS
  // ============================

  if (method === "GET" && url.startsWith("/api/risk-status")) {
    return await handleGetRiskStatus(req, res);
  }

  if (method === "GET" && url.startsWith("/api/risk-config")) {
    return await handleGetRiskConfig(req, res);
  }


  if (method === "GET" && url.startsWith("/api/trades")) {
    return await handleGetTrades(req, res);
  }

  // ============================
  //  NEW POST ENDPOINTS (admin)
  // ============================

  if (method === "POST" && url.startsWith("/api/risk-config")) {
    return await handlePostRiskConfig(req, res);
  }

  if (method === "POST" && url.startsWith("/api/reset-day")) {
    return await handlePostResetDay(req, res);
  }

  if (method === "POST" && url.startsWith("/api/cancel")) {
    return await handlePostCancel(req, res);
  }

  if (method === "POST" && url.startsWith("/api/kill")) {
    return await handlePostKill(req, res);
  }

  if (method === "POST" && url.startsWith("/api/sync-kv-state")) {
    return await handlePostSyncKvState(req, res);
  }
  if (method === "GET" && url.startsWith("/api/logs")) {
  return await handleGetLogs(req, res);
}


// If no route matched, return 404
res.statusCode = 404;
res.setHeader("Content-Type", "application/json");
res.end(JSON.stringify({ ok: false, detail: "Endpoint not found" }));
}

