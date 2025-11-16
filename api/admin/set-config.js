// api/admin/set-config.js
// Merge admin rule updates into today's risk:{YYYY-MM-DD} record.
// Accepts partial payloads. Normalizes p10_pct -> p10 (percentage) and computes
// derived fields (p10_effective_amount, max_loss_abs, active_loss_floor,
// remaining_to_max_loss) before persisting.
import { todayKey, setState, kv, getState } from "../_lib/kv.js";
function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// tolerant json parser (works on Vercel / serverless)
async function parseJson(req) {
  try {
    if (typeof req.json === "function") {
      return await req.json();
    }
  } catch (e) {
    // fallthrough
  }
  try {
    const chunks = [];
    for await (const chunk of req) chunks.push(typeof chunk === "string" ? chunk : chunk.toString());
    const txt = chunks.join("");
    if (!txt) return {};
    return JSON.parse(txt);
  } catch (e) {
    return null;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") {
    res.status(405).json({ ok: false, error: "Method not allowed" });
    return;
  }
  if (!isAdmin(req)) {
    res.status(401).json({ ok: false, error: "unauthorized" });
    return;
  }

  const body = await parseJson(req);
  if (body === null) {
    res.status(400).json({ ok: false, error: "invalid json" });
    return;
  }

  const patch = {};
  const toNum = (v) => {
    if (v === null || v === undefined || v === "") return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  // numeric rule fields (common)
  if (typeof body.max_loss_pct !== "undefined") {
    const v = toNum(body.max_loss_pct);
    if (typeof v !== "undefined") patch.max_loss_pct = v;
  }
  if (typeof body.trail_step_profit !== "undefined") {
    const v = toNum(body.trail_step_profit);
    if (typeof v !== "undefined") patch.trail_step_profit = v;
  }
  if (typeof body.cooldown_min !== "undefined") {
    const v = toNum(body.cooldown_min);
    if (typeof v !== "undefined") patch.cooldown_min = v;
  }
  if (typeof body.max_consecutive_losses !== "undefined") {
    const v = toNum(body.max_consecutive_losses);
    if (typeof v !== "undefined") patch.max_consecutive_losses = v;
  }

  // Max profit: accept percentage (p10_pct or p10) OR legacy rupee amount (p10_amount)
  if (typeof body.p10_pct !== "undefined") {
    const v = toNum(body.p10_pct);
    if (typeof v !== "undefined") {
      patch.p10 = v;
      patch.p10_is_pct = true;
    }
  } else if (typeof body.p10 !== "undefined") {
    const v = toNum(body.p10);
    if (typeof v !== "undefined") {
      // treat p10 in body as percentage when provided as 'p10' (backwards-compatible)
      patch.p10 = v;
      patch.p10_is_pct = true;
    }
  } else if (typeof body.p10_amount !== "undefined") {
    const v = toNum(body.p10_amount);
    if (typeof v !== "undefined") {
      patch.p10_amount = v;
      patch.p10_is_pct = false;
    }
  }

  // admin override capital flags and value
  if (typeof body.admin_override_capital !== "undefined") {
    patch.admin_override_capital = !!body.admin_override_capital;
  }
  if (typeof body.capital_day_915 !== "undefined") {
    const v = toNum(body.capital_day_915);
    if (typeof v !== "undefined") patch.capital_day_915 = v;
  }

  // other booleans
  if (typeof body.profit_lock_10 !== "undefined") patch.profit_lock_10 = !!body.profit_lock_10;
  if (typeof body.allow_new_after_lock10 !== "undefined") patch.allow_new_after_lock10 = !!body.allow_new_after_lock10;

  // Behavioral & Allow-new fixes (new section)
  if (typeof body.cooldown_on_profit !== "undefined") {
    patch.cooldown_on_profit = !!body.cooldown_on_profit;
  }
  if (typeof body.min_loss_to_count !== "undefined") {
    const v = toNum(body.min_loss_to_count);
    if (typeof v !== "undefined") patch.min_loss_to_count = v;
  }
  if (typeof body.allow_new !== "undefined") {
    patch.allow_new = !!body.allow_new;
    patch.block_new_orders = !patch.allow_new;
  }

  // --- support inline Reset Day via this endpoint (avoid extra function) ---
  if (body && body.reset_day === true) {
    try {
      const preserve = !!body.preserve_losses;
      const resetPatch = {
        tripped_day: false,
        tripped_week: false,
        tripped_month: false,
        block_new_orders: false,
        cooldown_until: 0,
        cooldown_active: false,
        trip_reason: null,
        last_reset_by: "admin",
        last_reset_at: Date.now(),
      };
      if (!preserve) resetPatch.consecutive_losses = 0;

      const updated = await setState(resetPatch);
      const key = `risk:${todayKey()}`;
      await kv.set(key, updated);

      return res.status(200).json({ ok: true, updated, note: "Day reset successfully", preserve_losses: preserve });
    } catch (err) {
      console.error("reset_day (inline) error:", err && err.stack ? err.stack : err);
      return res.status(500).json({ ok: false, error: err.message || String(err) });
    }
  }

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: "missing fields" });
    return;
  }

  try {
    // Apply base patch to state first (so we can read back capital/current totals)
    const updated = await setState(patch);

    // compute derived fields (p10_effective_amount, max_loss_abs, active_loss_floor, remaining_to_max_loss)
    try {
      // get freshest state after update
      const state = await getState();

      // determine capital to use
      const capital = Number(state.capital_day_915 || 0);

      // compute p10_effective_amount: prefer percent (p10 + p10_is_pct), else p10_amount
      let p10_effective = undefined;
      if (state.p10_is_pct === true && typeof state.p10 !== "undefined") {
        const pct = Number(state.p10 || 0);
        p10_effective = Math.round((capital * (pct / 100)) * 100) / 100; // round to 2 decimals
      } else if (typeof state.p10_amount !== "undefined") {
        p10_effective = Number(state.p10_amount || 0);
      } else if (typeof state.p10 !== "undefined" && state.p10_is_pct === undefined) {
        // legacy: if p10 present but p10_is_pct missing, treat p10 as percentage
        const pct = Number(state.p10 || 0);
        p10_effective = Math.round((capital * (pct / 100)) * 100) / 100;
        // persist p10_is_pct true for clarity
        await setState({ p10_is_pct: true });
      }

      // compute max_loss_abs & active_loss_floor using max_loss_pct
      const maxLossPct = Number(state.max_loss_pct ?? 0);
      const max_loss_abs = Math.round(capital * (maxLossPct / 100));
      const active_loss_floor = -Math.abs(max_loss_abs);

      // compute remaining_to_max_loss = max_loss_abs + total_pnl (total_pnl may be negative)
      const realised = Number(state.realised ?? 0);
      const unreal = Number(state.unrealised ?? 0);
      const total = Number(state.total_pnl ?? (realised + unreal));
      const remaining_to_max_loss = Math.round(max_loss_abs + total);

      const derivedPatch = {
        p10_effective_amount: typeof p10_effective !== "undefined" ? p10_effective : undefined,
        max_loss_abs: Number(max_loss_abs),
        active_loss_floor: Number(active_loss_floor),
        remaining_to_max_loss: Number(remaining_to_max_loss)
      };

      // remove undefined keys
      Object.keys(derivedPatch).forEach(k => {
        if (derivedPatch[k] === undefined) delete derivedPatch[k];
      });

      if (Object.keys(derivedPatch).length > 0) {
        const final = await setState(derivedPatch);
        // persist today's snapshot
        const key = `risk:${todayKey()}`;
        await kv.set(key, final);
        // return final merged state
        res.setHeader("Cache-Control", "no-store").status(200).json({ ok: true, updated: final });
        return;
      } else {
        // nothing to derive/persist further
        const key = `risk:${todayKey()}`;
        await kv.set(key, updated);
        res.setHeader("Cache-Control", "no-store").status(200).json({ ok: true, updated });
        return;
      }
    } catch (e) {
      // derived fields computation failed -> still return base updated state
      console.warn("set-config: derived field compute failed:", e && e.message ? e.message : e);
      const key = `risk:${todayKey()}`;
      await kv.set(key, updated);
      res.setHeader("Cache-Control", "no-store").status(200).json({ ok: true, updated, warn: "derived_compute_failed" });
      return;
    }
  } catch (err) {
    console.error("set-config error", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
