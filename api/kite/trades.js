// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";

const TRADEBOOK_KEY = "guardian:tradebook";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function dayKeyFromTs(ts) {
  try {
    const d = new Date(Number(ts));
    return d.toLocaleString("en-GB", { timeZone: "Asia/Kolkata" }).split(",")[0]
      .split("/").reverse().join("-");
  } catch { return null; }
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    const raw = await kv.get(TRADEBOOK_KEY);
    const arr = Array.isArray(raw) ? raw : [];

    // Filter today's trades only
    const nowIST = new Date(new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" }));
    const todayKeyStr = `${nowIST.getFullYear()}-${String(nowIST.getMonth()+1).padStart(2,"0")}-${String(nowIST.getDate()).padStart(2,"0")}`;
    const todayTrades = arr.filter(t => dayKeyFromTs(t.ts) === todayKeyStr);

    if (todayTrades.length > 0) {
      const recent = todayTrades.slice(-50).reverse();
      if (isAdmin(req))
        return res.status(200).json({ ok: true, source: "tradebook", trades: recent });
      return res.status(200).json(recent);
    }

    // fallback to Kite live trades
    try {
      const kc = await instance();
      const trades = (await kc.getTrades()) || [];
      if (trades.length)
        return res.status(200).json(trades.slice(-100));
    } catch (e) {
      console.warn("kite/trades fallback failed:", e);
    }

    return res.status(200).json({ ok: true, source: "empty", trades: [] });
  } catch (err) {
    console.error("kite/trades error:", err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
