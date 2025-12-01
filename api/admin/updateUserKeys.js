// /api/admin/updateUserKeys.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { user_id, api_key, api_secret } = req.body;

    if (!user_id || !api_key || !api_secret) {
      return res.json({ ok: false, error: "Missing fields" });
    }

    const uid = user_id.trim().toUpperCase();

    let profile = await kv.get(`user:${uid}`);
    if (!profile) {
      return res.json({ ok: false, error: "User not found" });
    }

    // Update keys
    profile.api_key = api_key;
    profile.api_secret = api_secret;
    profile.updated_at = Date.now();

    await kv.set(`user:${uid}`, profile);

    // Delete old access token
    await kv.del(`user:${uid}:access_token`);

    return res.json({ ok: true });

  } catch (err) {
    return res.json({ ok: false, error: err.toString() });
  }
}

export const config = { api: { bodyParser: true } };
