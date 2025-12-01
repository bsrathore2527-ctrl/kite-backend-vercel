import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // ✔ FIXED: read JSON from req.body
    const { user_id, valid_until } = req.body;

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    const profileKey = `u:${user_id}:profile`;

    const existing = await kv.get(profileKey);
    if (existing) {
      return res.status(400).json({ ok: false, error: "User already exists" });
    }

    await kv.set(profileKey, {
      id: user_id,
      active: true,
      is_master: false,
      valid_until: valid_until || (Date.now() + 7 * 86400000),
    });

    await kv.sadd("users:list", user_id);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("addUser error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}

// Let Vercel auto-parse JSON
export const config = {
  api: { bodyParser: true }
};
