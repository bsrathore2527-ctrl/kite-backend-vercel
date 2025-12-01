// /api/user/check.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ exists: false });

    // Load user list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    const exists = list.includes(user_id);

    if (!exists) {
      return res.json({ exists: false });
    }

    // Load profile
    let profile = await kv.get(`user:${user_id}`) || {};

    // Check access token
    const access = await kv.get(`user:${user_id}:access_token`);
    const connected = !!access;

    return res.json({
      exists: true,
      profile,
      connected
    });

  } catch (e) {
    console.error("check.js error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
