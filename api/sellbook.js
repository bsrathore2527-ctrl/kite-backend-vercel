// api/sellbook.js
import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const raw = await kv.get("guardian:sell_orders");
    return res.status(200).json({
      ok: true,
      sellbook: raw || []
    });
  } catch (err) {
    return res.status(500).json({ ok:false, error:String(err) });
  }
}
