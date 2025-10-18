import { kv, IST, todayKey } from "./_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST") { res.setHeader("Allow","POST"); return res.status(405).end(); }
  if (req.headers.authorization !== `Bearer ${process.env.ADMIN_TOKEN}`) return res.status(401).json({ error: "Unauthorized" });
  const body = typeof req.body === "string" ? JSON.parse(req.body||"{}") : (req.body||{});
  const key = `risk:${todayKey()}`;
  const prev = (await kv.get(key)) || {};
  const cfg = {
    // daily
    max_loss_pct: Number(body.max_loss_pct ?? prev.max_loss_pct ?? 10),
    trail_step_profit: Number(body.trail_step_profit ?? prev.trail_step_profit ?? 5000),
    cooldown_min: Number(body.cooldown_min ?? prev.cooldown_min ?? 15),
    max_consecutive_losses: Number(body.max_consecutive_losses ?? prev.max_consecutive_losses ?? 3),
    position_limit_pct: Number(body.position_limit_pct ?? prev.position_limit_pct ?? 30),
    allow_naked_selling: Boolean(body.allow_naked_selling ?? prev.allow_naked_selling ?? false),
    cutoff_eod: body.cutoff_eod || prev.cutoff_eod || "15:25",
    // profit locks
    lock10_enable: true,
    lock20_enable: true,
    // expiry
    expiry_flag: Boolean(body.expiry_flag ?? prev.expiry_flag ?? false),
    // weekly/monthly (phase 2 placeholders)
    week_enforce: Boolean(body.week_enforce ?? prev.week_enforce ?? false),
    week_loss_pct: Number(body.week_loss_pct ?? prev.week_loss_pct ?? 6),
    month_enforce: Boolean(body.month_enforce ?? prev.month_enforce ?? false),
    month_loss_pct: Number(body.month_loss_pct ?? prev.month_loss_pct ?? 12),
    // governance
    gov_locked_after_0915: prev.gov_locked_after_0915 ?? false,
    // runtime (preserve)
    capital_day_915: prev.capital_day_915 ?? null,
    realised: prev.realised ?? 0,
    unrealised: prev.unrealised ?? 0,
    last_realised: prev.last_realised ?? 0,
    cooldown_until: prev.cooldown_until ?? 0,
    consecutive_losses: prev.consecutive_losses ?? 0,
    loss_floor_dynamic: prev.loss_floor_dynamic ?? (-1 * (prev.max_loss_pct ?? 10) / 100),
    profit_lock_10: prev.profit_lock_10 ?? false,
    profit_lock_20: prev.profit_lock_20 ?? false,
    block_new_orders: prev.block_new_orders ?? false,
    tripped_day: prev.tripped_day ?? false,
    max_loss_hit_time: prev.max_loss_hit_time ?? null
  };
  await kv.set(key, cfg, { ex: 60*60*24*2 });
  res.json({ ok: true, saved: cfg });
}
