import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { user_id, days } = await req.json();

    if (!user_id || !days) {
      return res.status(400).json({ ok: false, error: "Missing parameters" });
    }

    const profileKey = `u:${user_id}:profile`;
    const profile = await kv.get(profileKey);

    if (!profile) {
      return res.status(404).json({ ok: false, error: "User not found" });
    }

    const extraMs = days * 24 * 60 * 60 * 1000;

    profile.valid_until = profile.valid_until + extraMs;

    await kv.set(profileKey, profile);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("extendValidity error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
