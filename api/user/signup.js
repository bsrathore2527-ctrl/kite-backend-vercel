// /api/user/signup.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { user_id, api_key, api_secret } = req.body;

    if (!user_id || !api_key || !api_secret)
      return res.json({ ok: false, error: "Missing fields" });

    // Check if user exists in admin list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    if (!list.includes(user_id)) {
      return res.json({ ok: false, error: "User not authorized" });
    }

    // Load existing profile or create new
    let profile = await kv.get(`user:${user_id}`) || {};

    profile.api_key = api_key;
    profile.api_secret = api_secret;
    profile.active = true;
    profile.updated_at = Date.now();

    await kv.set(`user:${user_id}`, profile);

    return res.json({ ok: true });

  } catch (e) {
    console.error("signup.js error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
