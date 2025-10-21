// api/kite/positions.js
import { kitePositions } from "../_lib/kite.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const r = await kitePositions();

    // r will be {ok:true, ...} or {ok:false, error:...}
    if (!r || r.ok === false) {
      // return 400 for kite errors that are expected (invalid token etc.)
      return res.status(400).json(r);
    }

    return res.status(200).json(r);
  } catch (e) {
    console.error("positions handler error:", e);
    return res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
