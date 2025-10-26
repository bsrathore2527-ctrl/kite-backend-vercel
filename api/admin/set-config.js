// api/admin/set-config.js
import { todayKey, setState, kv } from "../_lib/kv.js";

/**
 * Minimal admin config endpoint.
 * Accepts partial payload; merges into today's risk:{YYYY-MM-DD} KV entry.
 *
 * Allowed (optional) keys:
 * - max_loss_pct (number)
 * - trail_step_profit (number)
 * - cooldown_min (number)
 * - max_consecutive_losses (number)
 * - p10_amount (number)           -- max profit lock amount
 * - profit_lock_10 (boolean)     -- enable/disable 10% lock
 * - admin_override_capital (boolean)
 * - capital_day_915 (number)     -- admin override capital
 * - cooldown_on_profit (boolean)
 * - min_loss_to_count (number)
 *
 * Returns { ok: true, updated: {...} } on success.
 */

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

// safe JSON parse helper that works in various runtimes
async function parseJson(req) {
  // try built-in body parser (Next/vercel)
  try {
    if (typeof req.json === "function") {
      return await req.json();
    }
  } catch (e) {
    // fallthrough
  }

  // fallback: read raw body
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
  // only accept POST from admin
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

  // allowed fields and normalization
  const patch = {};
  const safeNum = (v) => {
    if (v === null || v === undefined) return undefined;
    const n = Number(v);
    return Number.isFinite(n) ? n : undefined;
  };

  if (typeof body.max_loss_pct !== "undefined") {
    const v = safeNum(body.max_loss_pct);
    if (typeof v !== "undefined") patch.max_loss_pct = v;
  }
  if (typeof body.trail_step_profit !== "undefined") {
    const v = safeNum(body.trail_step_profit);
    if (typeof v !== "undefined") patch.trail_step_profit = v;
  }
  if (typeof body.cooldown_min !== "undefined") {
    const v = safeNum(body.cooldown_min);
    if (typeof v !== "undefined") patch.cooldown_min = v;
  }
  if (typeof body.max_consecutive_losses !== "undefined") {
    const v = safeNum(body.max_consecutive_losses);
    if (typeof v !== "undefined") patch.max_consecutive_losses = v;
  }
  if (typeof body.p10_amount !== "undefined") {
    const v = safeNum(body.p10_amount);
    if (typeof v !== "undefined") patch.p10 = v;
  }
  if (typeof body.profit_lock_10 !== "undefined") {
    patch.profit_lock_10 = !!body.profit_lock_10;
  }
  if (typeof body.admin_override_capital !== "undefined") {
    patch.admin_override_capital = !!body.admin_override_capital;
  }
  if (typeof body.capital_day_915 !== "undefined") {
    const v = safeNum(body.capital_day_915);
    if (typeof v !== "undefined") patch.capital_day_915 = v;
  }
  if (typeof body.cooldown_on_profit !== "undefined") {
    patch.cooldown_on_profit = !!body.cooldown_on_profit;
  }
  if (typeof body.min_loss_to_count !== "undefined") {
    const v = safeNum(body.min_loss_to_count);
    if (typeof v !== "undefined") patch.min_loss_to_count = v;
  }

  // if nothing meaningful to save -> error (but not required)
  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: "missing fields" });
    return;
  }

  try {
    // setState merges into today's object (setState is implemented in your kv helper)
    const updated = await setState(patch);
    // also ensure the raw KV key exists and is updated directly for quick reads
    const key = `risk:${todayKey()}`;
    await kv.set(key, updated);

    res.setHeader("Cache-Control", "no-store").status(200).json({ ok: true, updated });
  } catch (err) {
    console.error("set-config error", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
