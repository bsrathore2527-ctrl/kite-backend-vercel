// api/kite/trades.js
// Returns today's trades — prefer server tradebook stored in KV (persisted by enforce-trades)
// fallback to live Kite trades if no tradebook found.
//
// This patched version normalizes timestamps to milliseconds (_ts) and normalizes price fields
// so the frontend can rely on consistent fields.

import { kv } from "../_lib/kv.js";
import { instance } from "../_lib/kite.js";

const TRADEBOOK_KEY = "guardian:tradebook";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

function toNumberOrNull(v) {
  if (v === null || typeof v === "undefined") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

function normalizeTsToMs(ts) {
  // Accept number or numeric string or ISO string.
  if (ts === null || typeof ts === "undefined") return null;
  // If it's already a number
  if (typeof ts === "number") {
    // 10-digit => seconds, convert to ms
    if (String(Math.trunc(ts)).length === 10) return ts * 1000;
    return ts;
  }
  // numeric string?
  if (/^\d+$/.test(String(ts).trim())) {
    const n = Number(ts);
    if (String(Math.trunc(n)).length === 10) return n * 1000;
    return n;
  }
  // Try Date.parse on other strings (ISO or common formats)
  const parsed = Date.parse(String(ts));
  if (!Number.isNaN(parsed)) return parsed;
  return null;
}

function normalizeTrade(t) {
  if (!t || typeof t !== "object") return t;
  const out = { ...t };

  // Normalize price: prefer avg_price, then price, then average_price/trade_price
  const candidates = [
    out.avg_price,
    out.average_price,
    out.trade_price,
    out.price,
    out.last_price,
  ];
  let price = null;
  for (const c of candidates) {
    const p = toNumberOrNull(c);
    if (p !== null && p !== 0) { price = p; break; }
  }
  // If still null, set to null (frontend will display '—')
  out.price_normalized = price;

  // Normalize timestamp into _ts (milliseconds since epoch)
  // prefer existing _ts, else common fields
  const possibleTs = out._ts || out.trade_time || out.timestamp || out.exchange_timestamp || out.order_timestamp || out.created_at || out.ts;
  const ms = normalizeTsToMs(possibleTs);
  out._ts = ms || out._ts || null;

  // Also add a human-friendly ISO for clarity
  out._iso = out._ts ? new Date(out._ts).toISOString() : null;

  return out;
}

export default async function handler(req, res) {
  try {
    // If admin asked for raw stored tradebook
    if (isAdmin(req) && req.query && req.query.raw === "1") {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      try {
        const arr = JSON.parse(raw);
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: arr });
      } catch (e) {
        return res.status(200).json({ ok: true, source: "kv", raw: true, trades: [] });
      }
    }

    // Try server-side persisted tradebook first (preferred)
    try {
      const raw = (await kv.get(TRADEBOOK_KEY)) || "[]";
      let arr = [];
      try {
        arr = JSON.parse(raw);
      } catch (e) {
        arr = [];
      }
      if (Array.isArray(arr) && arr.length) {
        // Normalize each trade before returning
        const normalized = arr.slice(-200).map(normalizeTrade);
        return res.status(200).json({ ok: true, source: "kv", trades: normalized });
      }
    } catch (e) {
      console.warn("kite/trades kv read failed:", e && e.message ? e.message : e);
    }

    // Fallback to live Kite trades
    try {
      const kc = await instance();
      const trades = (await kc.getTrades()) || [];
      if (trades.length) {
        const normalized = trades.slice(-200).map(normalizeTrade);
        return res.status(200).json({ ok: true, source: "kite", trades: normalized });
      }
    } catch (e) {
      console.warn("kite/trades fallback failed:", e && e.message ? e.message : e);
    }

    return res.status(200).json({ ok: true, source: "empty", trades: [] });
  } catch (err) {
    console.error("kite/trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
