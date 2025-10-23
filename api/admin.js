// api/admin.js
// Merged admin endpoint: lock/unlock/snapshot/trades
import { getState, setState } from "./_lib/state.js";
import { instance } from "./_lib/kite.js";
import { adjustedEquityFromFunds } from "./_lib/utils.js"; // ensure this exists or inline implementation below

const LOCK_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isAdminReq(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

async function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.on("data", (c) => (data += c));
    req.on("end", () => {
      try { resolve(JSON.parse(data || "{}")); } catch { resolve({}); }
    });
  });
}

// Fallback implementation if utils import not available
function _adjustedEquityFromFunds(funds) {
  if (!funds) return 0;
  const utilised = funds.utilised ?? funds?.utilised ?? {};
  const live = Number(
    funds.balance ??
    funds?.available?.live_balance ??
    funds?.net ??
    funds?.available?.cash ??
    funds?.cash ??
    0
  );
  const exposure = Number(utilised.exposure ?? 0);
  const debits = Number(utilised.debits ?? 0);
  const optPrem = Number(utilised.option_premium ?? 0);
  return live + exposure + debits + Math.abs(optPrem || 0);
}

export default async function handler(req, res) {
  try {
    const action = (req.query.action || "").toString().toLowerCase();
    if (!action) return res.status(400).json({ ok: false, error: "missing action" });

    // -- LOCK --
    if (action === "lock") {
      if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "forbidden" });
      const body = req.method === "POST" ? await readBody(req) : {};
      const client_id = body.client_id || body.client || "unknown";
      const label = body.label || body.client_label || "admin";

      const state = (await getState()) || {};
      const now = Date.now();
      const lock = state.admin_lock || null;

      if (!lock || now > (lock.expires_at || 0) || lock.owner === client_id) {
        state.admin_lock = {
          owner: client_id,
          label,
          acquired_at: now,
          expires_at: now + LOCK_TTL_MS
        };
        await setState(state);
        return res.json({ ok: true, locked: true, admin_lock: state.admin_lock });
      }

      return res.json({ ok: true, locked: false, admin_lock: lock, message: "locked by another" });
    }

    // -- UNLOCK --
    if (action === "unlock") {
      if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "forbidden" });
      const body = req.method === "POST" ? await readBody(req) : {};
      const client_id = body.client_id || body.client || null;
      const force = !!body.force;
      const overrideToken = req.headers["x-override-token"] || null;

      const state = (await getState()) || {};
      const lock = state.admin_lock || null;
      if (!lock) return res.json({ ok: true, unlocked: true, message: "no lock present" });

      // owner may release
      if (client_id && lock.owner === client_id) {
        delete state.admin_lock;
        await setState(state);
        return res.json({ ok: true, unlocked: true, by: client_id });
      }

      // force with override token
      if (force && process.env.ADMIN_OVERRIDE_TOKEN && overrideToken === process.env.ADMIN_OVERRIDE_TOKEN) {
        delete state.admin_lock;
        await setState(state);
        return res.json({ ok: true, unlocked: true, forced: true });
      }

      return res.status(403).json({ ok: false, error: "not owner, cannot unlock" });
    }

    // -- SNAPSHOT & PATCH (save rules) --
    if (action === "snapshot") {
      if (!isAdminReq(req)) return res.status(403).json({ ok: false, error: "forbidden" });
      const body = req.method === "POST" ? await readBody(req) : {};
      const patch = body.patch || {};
      const doSnapshot = !!body.snapshot;
      const client_id = body.client_id || body.client || "admin";

      const kc = instance();
      const state = (await getState()) || {};

      if (doSnapshot) {
        // try fetch funds, compute adjusted equity
        try {
          const funds = await (kc.getMargins?.() ?? kc.margins?.());
          const adjusted = (typeof adjustedEquityFromFunds === "function") ? adjustedEquityFromFunds(funds) : _adjustedEquityFromFunds(funds);
          state.capital_day_830 = Number(adjusted || 0);
          state.capital_snapshot_time = new Date().toISOString();
          // reset daily counters
          state.trade_count = 0;
          state.consecutive_losses = 0;
          state.daily_realized = 0;
        } catch (e) {
          // non-fatal
          console.warn("snapshot: kite unavailable", e?.message || e);
        }
      }

      // Merge allowed patch keys (safety)
      const allowed = [
        "max_loss_pct","trail_step_profit","cooldown_min","max_consecutive_losses",
        "max_trades_per_day","allow_new_after_lock10","week_max_loss_pct","month_max_loss_pct"
      ];
      if (patch && typeof patch === "object" && Object.keys(patch).length) {
        for (const k of Object.keys(patch)) {
          if (!allowed.includes(k)) continue;
          const numKeys = ['max_loss_pct','trail_step_profit','cooldown_min','max_consecutive_losses','max_trades_per_day','week_max_loss_pct','month_max_loss_pct'];
          state[k] = numKeys.includes(k) ? Number(patch[k] ?? state[k] ?? 0) : patch[k];
        }
      }

      // ---- Audit log append (keeps last 200) ----
      state.admin_activity = state.admin_activity || [];
      state.admin_activity.unshift({
        actor: client_id,
        action: 'snapshot_patch',
        patch_keys: Object.keys(patch || {}),
        timestamp: new Date().toISOString()
      });
      if (state.admin_activity.length > 200) state.admin_activity.length = 200;
      // -------------------------------------------

      await setState(state);
      return res.json({ ok: true, capital_day_830: state.capital_day_830, patched: Object.keys(patch || {}), state });
    }

    // -- TRADES (return realized history / ledger) --
    if (action === "trades") {
      const state = (await getState()) || {};
      return res.json({ ok: true, trades: state.trades || [], realized: state.realized_history || [], ledger: state.ledger || {} });
    }

    // -- TRACKER trigger (optional) --
    if (action === "tracker") {
      // We prefer tracker to be its own scheduled function.
      // Here just return info or instruct client to call /api/tracker if exists.
      const state = (await getState()) || {};
      return res.json({ ok: true, msg: "call /api/tracker for live polling (recommended)", has_trades: (state.trades || []).length });
    }

    return res.status(400).json({ ok: false, error: "unknown action" });
  } catch (err) {
    console.error("ADMIN ERROR:", err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
        }
