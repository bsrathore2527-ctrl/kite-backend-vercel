// api/state.js
// --------------------------------------------------
// Returns full current state + today's risk snapshot
// Clean, no legacy fields, compatible with new system
// --------------------------------------------------

import { getState, todayKey, kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const now = Date.now();

    // Load live state (always the most accurate)
    const state = (await getState()) || {};

    // Load today's snapshot from KV (optional)
    const dayKey = `risk:${todayKey()}`;
    const daily = (await kv.get(dayKey)) || null;

    // Build safe response object:
    const response = {
      ok: true,
      ts: now,

      // LIVE STATE (from getState)
      state: {
        // CONFIG:
        capital_day_915: state.capital_day_915 ?? 0,

        max_loss_pct: state.max_loss_pct ?? 0,
        max_loss_abs: state.max_loss_abs ?? 0,

        max_profit_pct: state.max_profit_pct ?? 0,
        max_profit_abs: state.max_profit_abs ?? 0,

        trail_step_profit: state.trail_step_profit ?? 0,
        min_loss_to_count: state.min_loss_to_count ?? 0,
        max_consecutive_losses: state.max_consecutive_losses ?? 0,
        cooldown_min: state.cooldown_min ?? 0,
        cooldown_on_profit: !!state.cooldown_on_profit,
        allow_new: state.allow_new !== undefined ? !!state.allow_new : true,

        // RUNTIME:
        realised: state.realised ?? 0,
        unrealised: state.unrealised ?? 0,
        total_pnl: state.total_pnl ?? (state.realised || 0) + (state.unrealised || 0),

        realised_history: Array.isArray(state.realised_history)
          ? state.realised_history
          : [],

        last_net_positions: state.last_net_positions || {},
        last_trade_time: state.last_trade_time ?? 0,
        consecutive_losses: state.consecutive_losses ?? 0,

        cooldown_active: !!state.cooldown_active,
        cooldown_until: state.cooldown_until ?? 0,

        peak_profit: state.peak_profit ?? 0,
        active_loss_floor: state.active_loss_floor ?? 0,
        remaining_to_max_loss: state.remaining_to_max_loss ?? 0,

        tripped_day: !!state.tripped_day,
        block_new_orders: !!state.block_new_orders,
        trip_reason: state.trip_reason || null,

        // LOGS:
        config_logs: state.config_logs || [],
        reset_logs: state.reset_logs || [],
        connection_logs: state.connection_logs || [],
        enforce_logs: state.enforce_logs || [],
        admin_last_enforce_result: state.admin_last_enforce_result || null,
      },

      // DAILY SNAPSHOT:
      daily_snapshot: daily,
    };

    return res.json(response);
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: String(err),
    });
  }
}
