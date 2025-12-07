// api/admin/set-config.js
// Unified Capital + Config + Optional Reset
//
// Writes to the same KV state as the risk engine:
// key: risk:${todayKey()} via getState/setState/kv

import { getState, setState, todayKey, kv } from "../_lib/kv.js";

/**
 * Safe JSON body parser that works on Vercel Node serverless
 * (reads the raw request body and JSON.parse's it).
 */
async function parseJsonBody(req) {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => {
      if (!body) return resolve(null);
      try {
        const parsed = JSON.parse(body);
        resolve(parsed);
      } catch (e) {
        reject(new Error("invalid json"));
      }
    });
    req.on("error", (err) => reject(err));
  });
}

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7).trim() : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      res.statusCode = 405;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Method not allowed" }));
    }

    if (!isAdmin(req)) {
      res.statusCode = 401;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "Unauthorized" }));
    }

    // Parse JSON body safely
    let body;
    try {
      body = await parseJsonBody(req);
    } catch (e) {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(
        JSON.stringify({
          ok: false,
          error: "invalid json",
          message: e.message,
        })
      );
    }

    if (!body || typeof body !== "object") {
      res.statusCode = 400;
      res.setHeader("Content-Type", "application/json");
      return res.end(JSON.stringify({ ok: false, error: "missing body" }));
    }

    const now = Date.now();
    let s = (await getState()) || {};

    const patch = {};

    // CAPITAL
    if (body.capital_day_915 !== undefined) {
      let c = Number(body.capital_day_915) || 0;
      c = Math.max(0, Math.round(c));
      patch.capital_day_915 = c;
    }

    // LOSS SIDE
    if (body.max_loss_pct !== undefined) {
      patch.max_loss_pct = Number(body.max_loss_pct) || 0;
    }
    if (body.max_loss_abs !== undefined) {
      patch.max_loss_abs = Number(body.max_loss_abs) || 0;
    }

    // PROFIT SIDE
    if (body.max_profit_pct !== undefined) {
      patch.max_profit_pct = Number(body.max_profit_pct) || 0;
    }
    if (body.max_profit_abs !== undefined) {
      patch.max_profit_abs = Number(body.max_profit_abs) || 0;
    }

    // TRAILING PROFIT STEP (in rupees; UI converts % → amount)
    if (body.trail_step_profit !== undefined) {
      patch.trail_step_profit = Number(body.trail_step_profit) || 0;
    }

    // COOL DOWN + CONSECUTIVE LOSS
    if (body.cooldown_min !== undefined) {
      patch.cooldown_min = Number(body.cooldown_min) || 0;
    }
    if (body.min_loss_to_count !== undefined) {
      patch.min_loss_to_count = Number(body.min_loss_to_count) || 0;
    }
    if (body.max_consecutive_losses !== undefined) {
      patch.max_consecutive_losses = Number(body.max_consecutive_losses) || 0;
    }

    // BEHAVIOR SWITCHES
    if (body.allow_new !== undefined) {
      patch.allow_new = !!body.allow_new;
    }
    if (body.cooldown_on_profit !== undefined) {
      patch.cooldown_on_profit = !!body.cooldown_on_profit;
    }

    // RESET DAY (optional)
    if (body.reset_day) {
      patch.realised = 0;
      patch.unrealised = 0;
      patch.total_pnl = 0;
      patch.realised_history = [];
      patch.last_net_positions = {};
      patch.last_trade_time = 0;
      patch.consecutive_losses = 0;
      patch.cooldown_active = false;
      patch.cooldown_until = 0;
      patch.tripped_day = false;
      patch.block_new_orders = false;
      patch.trip_reason = null;
      patch.peak_profit = 0;

      // Recompute loss floor / remaining loss
      const maxLossAbs =
        (patch.max_loss_abs !== undefined
          ? patch.max_loss_abs
          : s.max_loss_abs) || 0;
      patch.active_loss_floor = -maxLossAbs;
      patch.remaining_to_max_loss = maxLossAbs;

      const resetLogs = Array.isArray(s.reset_logs) ? [...s.reset_logs] : [];
      resetLogs.push({ time: now, reason: "manual_reset" });
      patch.reset_logs = resetLogs;
    }

    // LOG CONFIG CHANGES
    const confLog = Array.isArray(s.config_logs) ? [...s.config_logs] : [];
    confLog.push({ time: now, patch: body });
    patch.config_logs = confLog;

    // SAVE merged state to KV
    const next = await setState(patch);
    const dayKey = `risk:${todayKey()}`;
    await kv.set(dayKey, next);

    res.setHeader("Content-Type", "application/json");
    return res.end(JSON.stringify({ ok: true, state: next }));
  } catch (err) {
    console.error("set-config error:", err && err.stack ? err.stack : err);
    res.statusCode = 500;
    res.setHeader("Content-Type", "application/json");
    return res.end(
      JSON.stringify({ ok: false, error: err.message || String(err) })
    );
  }
}
