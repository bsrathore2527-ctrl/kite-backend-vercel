// api/_lib/kill.js
// Shared kill logic: cancels pending orders, closes positions, marks system tripped.
// Call this from admin/kill.js and from trades monitor (no HTTP required).

import { getState, saveState } from './state.js';    // replace with your exact state helpers
import * as kite from './kite.js';                    // expects functions: listOpenPositions, cancelAllOrders, placeOrder
import { kv } from './kv.js';                        // optional KV for locks/logs
// If you have an admin-utils module for auth helpers, this file DOES NOT need it.

const KILL_LOCK_KEY = 'kill_lock';
const KILL_LOG_PREFIX = 'kill:';

async function tryAcquireLock(ttlMs = 10000) {
  // Try to acquire a short-lived lock using kv if available.
  // Returns true if acquired, false otherwise.
  try {
    if (!kv || typeof kv.set !== 'function' || typeof kv.get !== 'function') return true;
    const now = Date.now();
    const lock = await kv.get(KILL_LOCK_KEY);
    if (lock) {
      // if lock exists and not expired, can't acquire
      const parsed = Number(lock) || 0;
      if (parsed + ttlMs > now) return false;
    }
    // set lock as timestamp
    await kv.set(KILL_LOCK_KEY, String(now));
    return true;
  } catch (e) {
    // If kv errors, fallback to permissive path
    console.warn('kill lock kv error', e);
    return true;
  }
}

async function releaseLock() {
  try {
    if (!kv || typeof kv.set !== 'function') return;
    await kv.set(KILL_LOCK_KEY, '');
  } catch (e) {
    // ignore
  }
}

/**
 * killNow - shared function to perform emergency close/cancel and mark system tripped.
 * @param {Object} opts
 *   - force {boolean} = allow closing tiny positions
 *   - reason {string} = reason text saved in state/log
 * @returns {Object} summary of actions and errors
 */
export async function killNow({ force = false, reason = 'auto' } = {}) {
  const summary = { ok: true, actions: [], errors: [], reason };

  // Acquire short lock to avoid concurrent kills
  const lockOk = await tryAcquireLock();
  if (!lockOk) {
    return { ok: false, error: 'kill_locked', message: 'Another kill operation is in progress.' };
  }

  try {
    // Load state (idempotency check)
    const state = (typeof getState === 'function') ? await getState() : null;
    if (state && state.tripped_day) {
      // Already tripped — return minimal info
      summary.actions.push({ step: 'already_tripped', ts: Date.now() });
      return summary;
    }

    // 1) Cancel pending orders (best-effort)
    try {
      if (typeof kite.cancelAllOrders === 'function') {
        const cancelRes = await kite.cancelAllOrders();
        summary.actions.push({ step: 'cancel_all', result: cancelRes });
      } else if (typeof kite.cancelPending === 'function') {
        const cancelRes = await kite.cancelPending();
        summary.actions.push({ step: 'cancel_all', result: cancelRes });
      } else {
        summary.actions.push({ step: 'cancel_all', result: 'no-cancel-fn' });
      }
    } catch (e) {
      summary.errors.push({ step: 'cancel_all', error: String(e) });
    }

    // 2) List open positions
    let positions = [];
    try {
      if (typeof kite.listOpenPositions === 'function') {
        positions = await kite.listOpenPositions();
      } else if (typeof kite.positions === 'function') {
        positions = await kite.positions();
      } else if (typeof kite.getPositions === 'function') {
        positions = await kite.getPositions();
      } else {
        positions = [];
      }
      summary.actions.push({ step: 'list_positions', count: (positions && positions.length) || 0 });
    } catch (e) {
      summary.errors.push({ step: 'list_positions', error: String(e) });
    }

    // 3) Close positions: place market orders to neutralize each position
    const closeResults = [];
    for (const pos of positions || []) {
      try {
        // determine quantity (var names may differ)
        const qty = Math.abs(Number(pos.quantity ?? pos.qty ?? pos.net_quantity ?? 0));
        if (!force && (!qty || qty < 1)) {
          closeResults.push({ position: pos, skipped: true, reason: 'tiny_qty' });
          continue;
        }

        // determine which transaction type closes the position:
        // common convention: if pos.side == 'BUY' (long), close with SELL; if 'SELL' close with BUY.
        const sideRaw = String(pos.side ?? pos.transaction_type ?? '').toUpperCase();
        const closeSide = (sideRaw.includes('SELL') || sideRaw === 'SHORT') ? 'BUY' : 'SELL';

        // Build order payload - adapt keys if kite.placeOrder expects different shape
        const orderReq = {
          tradingsymbol: pos.tradingsymbol ?? pos.instrument_token ?? pos.symbol,
          exchange: pos.exchange ?? pos.exchange_code ?? 'NSE',
          quantity: qty,
          order_type: 'MARKET',
          transaction_type: closeSide,
          product: pos.product ?? 'MIS', // choose as appropriate
        };

        // place order using kite wrapper
        let placed;
        if (typeof kite.placeOrder === 'function') {
          placed = await kite.placeOrder(orderReq);
        } else if (typeof kite.order === 'function') {
          placed = await kite.order(orderReq);
        } else {
          throw new Error('no-placeOrder-func');
        }
        closeResults.push({ position: pos, order: placed });
      } catch (e) {
        closeResults.push({ position: pos, error: String(e) });
      }
    }
    summary.actions.push({ step: 'close_positions', results: closeResults });

    // 4) Mark system state: tripped_day, disallow new, save last_kill_ts and reason
    try {
      if (typeof saveState === 'function') {
        const newState = Object.assign({}, state || {}, {
          tripped_day: true,
          allow_new: false,
          last_kill_ts: Date.now(),
          kill_reason: reason
        });
        await saveState(newState);
        summary.actions.push({ step: 'update_state', ok: true });
      } else if (typeof kite.saveState === 'function') {
        // fallback
        await kite.saveState({ tripped_day: true });
        summary.actions.push({ step: 'update_state', ok: true, fallback: true });
      } else {
        summary.actions.push({ step: 'update_state', ok: false, reason: 'no-saveState-func' });
      }
    } catch (e) {
      summary.errors.push({ step: 'update_state', error: String(e) });
    }

    // 5) Persist audit log into KV (optional)
    try {
      if (kv && typeof kv.set === 'function') {
        const logKey = `${KILL_LOG_PREFIX}${Date.now()}`;
        await kv.set(logKey, JSON.stringify(summary));
      }
    } catch (e) {
      // non-fatal
    }

    return summary;
  } finally {
    // release lock
    try { await releaseLock(); } catch (e) { /* ignore */ }
  }
}
