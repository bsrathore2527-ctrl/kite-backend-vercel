import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { user_id, days } = req.body;

    let profile = await kv.get(`user:${user_id}`);

    // Auto-recovery: if corrupted or missing
    if (!profile || typeof profile !== "object") {
      profile = {
        active: true,
        valid_until: Date.now(),
        created_at: Date.now()
      };
    }

    profile.valid_until += days * 86400000;
    profile.active = true;

    await kv.set(`user:${user_id}`, profile);

    return res.json({ ok: true });

  } catch (e) {
    console.error("extendValidity error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
