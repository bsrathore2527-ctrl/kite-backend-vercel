// api/kite/trades.js
import { instance } from "../_lib/kite.js";

/**
 * Returns today's executed trades from Kite in a normalized array.
 * Non-authorized calls will still work if your instance() handles session.
 * This endpoint attempts to call kc.getTrades() and returns an array.
 */
export default async function handler(req, res) {
  try {
    // Accept GET
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    let kc;
    try {
      kc = await instance(); // may throw if not connected
    } catch (e) {
      return res.status(200).json({ ok: false, error: "Kite not connected: " + (e.message || String(e)) });
    }

    // KiteConnect method usually getTrades() - returns array
    let trades = [];
    try {
      trades = await kc.getTrades();
      // normalize: ensure it's an array
      if (!Array.isArray(trades)) {
        return res.status(200).json({ ok: false, error: "kc.getTrades returned unexpected shape", raw: trades });
      }

      // Optionally filter to today's trades only (by timestamp)
      const todayStart = new Date().toLocaleString("en-US", { timeZone: "Asia/Kolkata" });
      // We won't filter here to keep full data; client can filter if needed

      return res.status(200).json({ ok: true, trades });
    } catch (err) {
      return res.status(200).json({ ok: false, error: "kc.getTrades error: " + (err && err.message ? err.message : String(err)) });
    }
  } catch (err) {
    console.error("trades endpoint error:", err && err.stack ? err.stack : err);
    return res.status(500).json({ ok: false, error: err.message || String(err) });
  }
}
