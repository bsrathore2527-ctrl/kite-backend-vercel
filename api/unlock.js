// api/unlock.js
import { kv, todayKey } from "./_lib/kv.js";

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") return res.status(405).json({ ok: false, error: "Method not allowed" });

  const auth = req.headers.authorization || "";
  const token = auth.startsWith("Bearer ") ? auth.slice(7) : "";
  if (!token || token !== (process.env.ADMIN_TOKEN || "")) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  const key = `risk:${todayKey()}`;
  const s = (await kv.get(key)) || {};
  s.block_new_orders = false;
  // DO NOT reset tripped_day or counters here; admin only lifts block for controlled cases.
  await kv.set(key, s, { ex: 60 * 60 * 24 * 2 });
  return res.json({ ok: true, message: "Trading unlocked (rules still apply)", state: { block_new_orders: false } });
}
