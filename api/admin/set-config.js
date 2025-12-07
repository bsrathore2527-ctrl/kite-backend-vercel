// set-config.js (Unified Capital + Config + Reset)

import { getState, setState, todayKey, kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }

  try {
    const body = req.body || {};
    const now = Date.now();
    let s = (await getState()) || {};

    const patch = {};

    // CAPITAL
    if (body.capital_day_915 !== undefined) {
      const c = Number(body.capital_day_915) || 0;
      patch.capital_day_915 = c;
    }

    // LOSS SIDE
    if (body.max_loss_pct !== undefined) patch.max_loss_pct = Number(body.max_loss_pct) || 0;
    if (body.max_loss_abs !== undefined) patch.max_loss_abs = Number(body.max_loss_abs) || 0;

    // PROFIT SIDE
    if (body.max_profit_pct !== undefined) patch.max_profit_pct = Number(body.max_profit_pct) || 0;
    if (body.max_profit_abs !== undefined) patch.max_profit_abs = Number(body.max_profit_abs) || 0;

    // TRAILING LOSS STEP (optional)
    if (body.trail_step_profit !== undefined) patch.trail_step_profit = Number(body.trail_step_profit) || 0;

    // COOL DOWN + CONSECUTIVE LOSS
    if (body.cooldown_min !== undefined) patch.cooldown_min = Number(body.cooldown_min) || 0;
    if (body.min_loss_to_count !== undefined) patch.min_loss_to_count = Number(body.min_loss_to_count) || 0;
    if (body.max_consecutive_losses !== undefined) patch.max_consecutive_losses = Number(body.max_consecutive_losses) || 0;

    // BEHAVIOR SWITCHES
    if (body.allow_new !== undefined) patch.allow_new = !!body.allow_new;
    if (body.cooldown_on_profit !== undefined) patch.cooldown_on_profit = !!body.cooldown_on_profit;

    // RESET DAY
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

      const maxLossAbs = patch.max_loss_abs || s.max_loss_abs || 0;
      patch.active_loss_floor = -(maxLossAbs);
      patch.remaining_to_max_loss = maxLossAbs;

      const arr = Array.isArray(s.reset_logs) ? [...s.reset_logs] : [];
      arr.push({ time: now, reason: "manual_reset" });
      patch.reset_logs = arr;
    }

    // LOG CONFIG CHANGES
    const confLog = Array.isArray(s.config_logs) ? [...s.config_logs] : [];
    confLog.push({ time: now, patch: body });
    patch.config_logs = confLog;

    // SAVE
    const next = await setState(patch);
    const dayKey = `risk:${todayKey()}`;
    await kv.set(dayKey, next);

    return res.json({ ok: true, state: next });
  } catch (err) {
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
