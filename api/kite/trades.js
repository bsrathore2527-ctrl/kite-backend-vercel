// api/kite/trades.js
// Returns recent trades — prefer live Kite trades; fallback to server-side tradebook stored in KV.

import { kv } from "../_lib/kv.js";          // ✅ fixed path (was ./_lib)
import { instance } from "../_lib/kite.js";  // ✅ fixed path (was ./_lib)

const TRADEBOOK_KEY = "guardian:tradebook";

function isAdmin(req) {
  const a = req.headers.authorization || "";
  const token = a.startsWith("Bearer ") ? a.slice(7) : "";
  return !!process.env.ADMIN_TOKEN && token === process.env.ADMIN_TOKEN;
}

export default async function handler(req, res) {
  // accept GET
  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET")
    return res.status(405).json({ ok: false, error: "Method not allowed" });

  try {
    // try kite first
    try {
      const kc = await instance();
      const trades = (await kc.getTrades()) || [];
      if (Array.isArray(trades) && trades.length > 0) {
        // return raw kite trades (UI can parse)
        return res
          .setHeader("Cache-Control", "no-store")
          .status(200)
          .json(trades);
      }
    } catch (e) {
      console.warn(
        "kite/trades kite fetch failed:",
        e && e.message ? e.message : e
      );
      // fallthrough to tradebook
    }

    // fallback: read stored tradebook
    const raw = await kv.get(TRADEBOOK_KEY);
    const arr = Array.isArray(raw) ? raw : [];

    // if admin request, return extra metadata
    if (isAdmin(req)) {
      return res
        .setHeader("Cache-Control", "no-store")
        .status(200)
        .json({ ok: true, source: "tradebook", trades: arr });
    } else {
      // public UI call — return array
      return res
        .setHeader("Cache-Control", "no-store")
        .status(200)
        .json(arr);
    }
  } catch (err) {
    console.error("kite/trades error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: String(err) });
  }
}
