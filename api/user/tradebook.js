import { kv } from "../_lib/kv.js";
import { createKiteInstanceForUser } from "../_lib/kite-user-instance.js";

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ ok:false, error:"Missing user_id" });
    }

    const userInfo = await kv.get(`user:${user_id}:info`);
    if (!userInfo) {
      return res.status(401).json({ ok:false, error:"Unauthorized user" });
    }

    const kc = await createKiteInstanceForUser(user_id);
    const trades = await kc.getTrades();

    return res.status(200).json({
      ok: true,
      trades: trades || []
    });
  } catch (err) {
    console.error("tradebook API error:", err);
    return res.status(500).json({ ok:false, error: err.message });
  }
}
