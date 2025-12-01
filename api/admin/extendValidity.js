import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id, days } = req.body;
    if (!user_id || !days)
      return res.status(400).json({ ok: false });

    const key = `u:${user_id}:profile`;
    const profile = await kv.get(key);
    if (!profile)
      return res.status(404).json({ ok: false });

    profile.valid_until += days * 86400000;
    await kv.set(key, profile);

    res.json({ ok: true });

  } catch (err) {
    console.error("extendValidity error", err);
    res.status(500).json({ ok: false });
  }
}

export const config = { api: { bodyParser: true } };
