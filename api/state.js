// api/state.js
// Central state endpoint for admin UI.
// Returns JSON with persisted state + derived fields (UTC-based).
// Minimal, defensive, avoids duplicate identifier imports.

import { getState, setState } from './_lib/kv.js';
import { todayKeyUTC, normalizeTsToMs } from './_lib/time.js';

function safeNum(v, fallback = 0) {
  const n = Number(v);
  return Number.isFinite(n) ? n : fallback;
}

export default async function handler(req, res) {
  try {
    // no caching
    res.setHeader('Cache-Control', 'no-store');

    // now in UTC ms
    const nowMs = Date.now();
    const nowIso = new Date(nowMs).toISOString();
    const nowTimeUTC = new Date(nowMs).toLocaleTimeString('en-GB', { hour12: false, timeZone: 'UTC' });

    // load persisted state (best-effort)
    let persisted = {};
    try {
      const p = await getState(); // getState should return an object or null
      if (p && typeof p === 'object') persisted = p;
    } catch (e) {
      console.warn('getState error:', e && e.message ? e.message : e);
      persisted = {};
    }

    // Base values
    const realised = safeNum(persisted.realised ?? persisted.realized ?? 0, 0);
    const unrealised = safeNum(persisted.unrealised ?? persisted.unrealized ?? 0, 0);
    const total_pnl = Math.round(realised + unrealised);

    // Capital and base loss
    const capital = safeNum(persisted.capital_day_915 ?? persisted.capital ?? persisted.base_capital ?? 0, 0);
    const max_loss_pct = safeNum(persisted.max_loss_pct ?? 0, 0); // percent like 10
    // prefer stored absolute max_loss_abs if present, else compute from capital and pct
    let base_loss_abs = safeNum(persisted.max_loss_abs ?? persisted.base_loss_abs ?? 0, 0);
    if (!base_loss_abs && capital > 0 && max_loss_pct > 0) {
      base_loss_abs = Math.round(capital * (max_loss_pct / 100));
    }

    // Active loss floor per your rule: active_loss_floor = realised - base_loss_abs
    const active_loss_floor = Math.round(realised - base_loss_abs);

    // Remaining to max loss (room before hitting floor) = total_pnl - active_loss_floor
    // Equivalent to unrealised + base_loss_abs, but compute from total to avoid rounding mismatch
    const remaining_to_max_loss = Math.round(total_pnl - active_loss_floor);

    // last trade time normalization (if persisted stored something)
    let last_trade_ts = null;
    if (persisted.last_trade_time) {
      // could be ms number or ISO or other; use normalizeTsToMs
      const ms = normalizeTsToMs(persisted.last_trade_time) || normalizeTsToMs(persisted.last_trade_ts) || null;
      if (ms) last_trade_ts = ms;
    } else if (persisted.last_trade_ts) {
      const ms = normalizeTsToMs(persisted.last_trade_ts);
      if (ms) last_trade_ts = ms;
    }

    // prepare response state object (do not mutate persisted input unexpectedly)
    const out = {
      ok: true,
      // timestamps
      time: nowTimeUTC,
      time_ms: nowMs,
      time_iso: nowIso,
      today_key_utc: todayKeyUTC(),

      // persisted core values (fall back to 0)
      realised,
      unrealised,
      total_pnl,

      capital,
      max_loss_pct,
      base_loss_abs,

      // derived protection values
      active_loss_floor,
      remaining_to_max_loss,

      // cooldown / trip flags (propagate if present in persisted)
      cooldown_active: Boolean(persisted.cooldown_active || false),
      cooldown_until: persisted.cooldown_until ?? null,
      consecutive_losses: safeNum(persisted.consecutive_losses ?? persisted.consec_losses ?? 0, 0),
      tripped_day: Boolean(persisted.tripped_day || false),

      // last trade info (ms and iso)
      last_trade_ts: last_trade_ts,
      last_trade_iso: last_trade_ts ? new Date(last_trade_ts).toISOString() : (persisted.last_trade_iso ?? null)
    };

    // Merge a few other useful persisted fields into response (non-destructive)
    const copyIfPresent = ['max_profit_pct', 'p10', 'p10_amount', 'trail_step_profit'];
    for (const k of copyIfPresent) {
      if (k in persisted) out[k] = persisted[k];
    }

    // Persist selected derived numeric fields back into today's state so other endpoints can read them.
    // we write only a small subset to avoid overwriting user-config: realised/unrealised/total_pnl/base_loss_abs/active_loss_floor/remaining...
    try {
      const patch = {
        realised: out.realised,
        unrealised: out.unrealised,
        total_pnl: out.total_pnl,
        base_loss_abs: out.base_loss_abs,
        active_loss_floor: out.active_loss_floor,
        remaining_to_max_loss: out.remaining_to_max_loss,
        last_trade_ts: out.last_trade_ts,
        last_trade_iso: out.last_trade_iso
      };
      // Merge patch on top of persisted and write (getState/setState expected to handle object stored as JSON)
      const merged = Object.assign({}, persisted, patch);
      await setState(merged);
    } catch (e) {
      // non-fatal
      console.warn('Failed to persist derived state patch:', e && e.message ? e.message : e);
    }

    return res.status(200).json(out);
  } catch (err) {
    console.error('Error in /api/state handler:', err && err.stack ? err.stack : err);
    // Do not reveal internals to non-admins: return safe message
    return res.status(500).json({ ok: false, error: String(err && err.message ? err.message : err) });
  }
}
