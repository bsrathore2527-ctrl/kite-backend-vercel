// api/debug/sim-trade.js
// Robust simulator for SELL/BUY/loss3/reset. Safe by default (enforce=false).
import { getState, setState, updateState } from '../_lib/state.js';
import { cancelPending, squareOffAll } from '../enforce.js';
import { instance } from '../_lib/kite.js';

// Helper admin check (expects ADMIN_TOKEN plain or "Bearer ...")
function isAdmin(req){
  const a = req.headers?.authorization || '';
  const token = a.startsWith('Bearer ') ? a.slice(7) : a;
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// Try to sample MTM from Kite if not supplied
async function sampleMtmFromKite(){
  try {
    const kc = await instance();
    const pos = await kc.getPositions();
    const net = pos?.net || [];
    let total = 0;
    for (const p of net) total += Number(p.m2m ?? p.unrealised ?? 0);
    return Number(total);
  } catch (e) {
    console.error('sampleMtmFromKite error', e && e.message ? e.message : e);
    return 0;
  }
}

export default async function handler(req, res){
  try {
    if (req.method !== 'POST') return res.status(405).json({ ok:false, error:'use POST' });
    if (!isAdmin(req)) return res.status(403).json({ ok:false, error:'forbidden' });

    const body = req.body || {};
    const action = (body.action || body.type || '').toString().toUpperCase();

    // default enforce=false to be safe; client may pass enforce:true when it wants real enforcement
    const enforceFlag = (typeof body.enforce === 'undefined') ? false : Boolean(body.enforce);

    if (action === 'SELL' || action === 'SELL_SIM' || action === 'SIM_SELL') {
      const mtmNow = (typeof body.mtm === 'number') ? Number(body.mtm) : await sampleMtmFromKite();

      // update persisted state atomically using updateState (if available)
      await updateState((s = {}) => {
        const prev = Number(s.last_mtm ?? 0);
        const delta = Number(mtmNow) - prev;
        const isLoss = delta < 0;
        const now = Date.now();

        let consec = Number(s.consecutive_losses ?? 0);
        if (isLoss) {
          consec = consec + 1;
          s.cooldown_until = now + (Number(s.cooldown_min ?? 15) * 60 * 1000);
          s.last_loss_ts = now;
        } else {
          consec = 0;
        }

        s.last_mtm = Number(mtmNow);
        s.last_mtm_ts = now;
        s.last_realised_change = delta;
        s.last_realised_change_ts = now;
        s.last_sell_ts = now;
        s.consecutive_losses = consec;

        return s;
      });

      // re-read authoritative state
      let finalState = await getState();

      // Only enforce (close/cancel) if explicitly requested
      try {
        const maxConsec = Number(finalState.max_consecutive_losses ?? 0);
        if (enforceFlag && maxConsec > 0 && Number(finalState.consecutive_losses ?? 0) >= maxConsec && !finalState.tripped_day) {
          // Prefer existing helper if present (markTrippedAndKillInternal)
          if (typeof globalThis.markTrippedAndKillInternal === 'function') {
            await globalThis.markTrippedAndKillInternal('consecutive_losses_sim', { consec: finalState.consecutive_losses, mtm: mtmNow, simulated: false });
          } else {
            // fallback: set tripped flag and call cancel/square
            const now = Date.now();
            const next = { ...(finalState || {}), tripped_day: true, block_new_orders: true, last_enforced_at: now, tripped_reason: 'consecutive_losses_sim' };
            await setState(next);
            try {
              const cancelled = await cancelPending();
              const squared = await squareOffAll();
              next.admin_last_enforce_result = { cancelled, squared, at: Date.now() };
              await setState(next);
            } catch (e) {
              console.error('enforce fallback error', e);
            }
            finalState = await getState();
          }
        }
      } catch (e) {
        console.error('post-sell enforcement check error', e);
      }

      finalState = await getState();
      return res.json({ ok: true, action: 'SELL_simulated', updated: finalState });
    }

    if (action === 'BUY' || action === 'SIM_BUY') {
      // Buying during cooldown should trip only if enforce:true
      let finalState = await getState();
      const cooldown = Number(finalState.cooldown_until ?? 0);
      if (!finalState.tripped_day && cooldown && Date.now() < cooldown) {
        if (enforceFlag) {
          // mark tripped and persist
          const now = Date.now();
          const next = { ...(finalState || {}), tripped_day: true, block_new_orders: true, last_enforced_at: now, tripped_reason: 'buy_during_cooldown_sim' };
          await setState(next);
          try {
            const cancelled = await cancelPending();
            const squared = await squareOffAll();
            next.admin_last_enforce_result = { cancelled, squared, at: Date.now() };
            await setState(next);
          } catch (e) {
            console.error('enforce fallback error', e);
          }
          finalState = await getState();
          return res.json({ ok: true, action: 'BUY_simulated_enforced', updated: finalState });
        } else {
          // dry-run: do not trip, just return state
          return res.json({ ok: true, action: 'BUY_simulated_no_enforce', updated: finalState });
        }
      }
      return res.json({ ok: true, action: 'BUY_simulated_noop', updated: finalState });
    }

    if (action === 'LOSS3' || action === 'SIM_LOSS3') {
      // Simulate three successive sell losses (decreasing mtm)
      let st = await getState();
      let prev = Number(st.last_mtm ?? 10000);
      for (const d of [500, 1000, 1500]) {
        const mtmNow = prev - d;
        await updateState(s => {
          const prevM = Number(s.last_mtm ?? 0);
          const delta = mtmNow - prevM;
          const now = Date.now();
          s.last_mtm = mtmNow;
          s.last_mtm_ts = now;
          s.last_realised_change = delta;
          s.last_realised_change_ts = now;
          s.last_sell_ts = now;
          s.consecutive_losses = Number(s.consecutive_losses ?? 0) + 1;
          s.cooldown_until = now + (Number(s.cooldown_min ?? 15) * 60 * 1000);
          s.last_loss_ts = now;
          return s;
        });
        prev = mtmNow;
      }
      const finalState = await getState();
      return res.json({ ok: true, action: 'LOSS3_simulated', updated: finalState });
    }

    if (action === 'RESET' || action === 'RESET_STATE') {
      // best-effort safe reset (admin-only)
      await updateState((s = {}) => {
        s.consecutive_losses = 0;
        s.cooldown_until = 0;
        s.last_mtm = 0;
        s.last_mtm_ts = 0;
        s.tripped_day = false;
        s.block_new_orders = false;
        s.last_realised_change = 0;
        s.last_realised_change_ts = null;
        return s;
      });
      const finalState = await getState();
      return res.json({ ok: true, action: 'RESET_simulated', updated: finalState });
    }

    return res.status(400).json({ ok:false, error:'unknown action (use type/action SELL|BUY|LOSS3|RESET)' });
  } catch (err) {
    console.error('sim-trade handler error', err && err.stack ? err.stack : err);
    return res.status(500).json({ ok:false, error: String(err) });
  }
            }
