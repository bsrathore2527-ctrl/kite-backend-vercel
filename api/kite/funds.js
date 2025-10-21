// api/kite/funds.js
import { kiteFunds } from "../_lib/kite.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const r = await kiteFunds();
    if (!r || r.ok === false) return res.status(400).json(r);

    // normalize result and expose `balance` top-level if present
    const out = { ok: true, ...r };
    // some responses wrap funds differently, keep original for debugging
    return res.status(200).json(out);
  } catch (e) {
    console.error("funds handler error:", e);
    return res.status(500).json({ ok: false, error: String(e) });
  }
}
