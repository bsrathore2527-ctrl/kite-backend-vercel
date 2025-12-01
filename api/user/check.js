// /api/user/check.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ exists: false });

    const uid = user_id.trim().toUpperCase();

    // Load list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    const exists = list.includes(uid);

    if (!exists) {
      return res.json({
        exists: false,
        reason: "not_in_admin_list"
      });
    }

    // Load profile
    let profile = await kv.get(`user:${uid}`) || {};

    // Determine if signup needed
    const signup_required = !(profile.api_key && profile.api_secret);

    // Check if connected
    const access = await kv.get(`user:${uid}:access_token`);
    const connected = !!access;

    return res.json({
      exists: true,
      signup_required,
      connected,
      profile
    });

  } catch (e) {
    console.error("check.js error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
