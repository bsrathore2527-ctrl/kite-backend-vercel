// api/admin/set-config.js
// Merge admin rule updates into today's risk:{YYYY-MM-DD} record.
// Accepts partial payloads. Normalizes p10_pct -> p10 (percentage).
import { todayKey, setState, kv } from "../_lib/kv.js";

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

  // Max profit: prefer p10_pct (percentage). Accept legacy p10_amount (rupee).
  if (typeof body.p10_pct !== "undefined") {
    const v = toNum(body.p10_pct);
    if (typeof v !== "undefined") {
      // Save percentage value into `p10` for state exposure (previous code expects s.p10)
      patch.p10 = v;
      // also store a helper flag
      patch.p10_is_pct = true;
    }
  } else if (typeof body.p10 !== "undefined") {
    // UI might post p10 — treat as percentage by default
    const v = toNum(body.p10);
    if (typeof v !== "undefined") {
      patch.p10 = v;
      patch.p10_is_pct = true;
    }
  } else if (typeof body.p10_amount !== "undefined") {
    // legacy rupee amount — store separately so UI can render as rupees if needed
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

  if (Object.keys(patch).length === 0) {
    res.status(400).json({ ok: false, error: "missing fields" });
    return;
  }

  try {
    // setState merges with today's record
    const updated = await setState(patch);
    // also write raw key for quick reads (defensive)
    const key = `risk:${todayKey()}`;
    await kv.set(key, updated);
    res.setHeader("Cache-Control", "no-store").status(200).json({ ok: true, updated });
  } catch (err) {
    console.error("set-config error", err && err.stack ? err.stack : err);
    res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
