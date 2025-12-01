// /api/user/debug-log.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const logs = await kv.get("debug:callback") || [];
    return res.status(200).json({ count: logs.length, logs });
  } catch (e) {
    return res.status(500).json({ error: e.toString() });
  }
}
