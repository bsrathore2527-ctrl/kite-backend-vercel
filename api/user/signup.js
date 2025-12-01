// /api/user/signup.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { user_id, api_key, api_secret } = req.body;

    if (!user_id || !api_key || !api_secret)
      return res.json({ ok: false, error: "Missing fields" });

    const uid = user_id.trim().toUpperCase();

    // Load admin-approved list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    if (!list.includes(uid)) {
      return res.json({
        ok: false,
        error: "User not found in admin list"
      });
    }

    // Load or create profile
    let profile = await kv.get(`user:${uid}`);
    if (!profile || typeof profile !== "object") {
      profile = {
        active: true,
        valid_until: Date.now() + 86400000, // fill placeholder; admin logic overwrites anyway
        created_at: Date.now()
      };
    }

    // Store user credentials
    profile.api_key = api_key;
    profile.api_secret = api_secret;
    profile.signup_at = Date.now();

    await kv.set(`user:${uid}`, profile);

    // Reset old token if any
    await kv.del(`user:${uid}:access_token`);

    return res.json({ ok: true });

  } catch (e) {
    console.error("signup.js error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
