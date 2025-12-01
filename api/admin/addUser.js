import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id, valid_until } = req.body;

    if (!user_id)
      return res.status(400).json({ ok: false, error: "Missing user_id" });

    const key = `u:${user_id}:profile`;
    const exists = await kv.get(key);

    if (exists)
      return res.status(400).json({ ok: false, error: "User already exists" });

    await kv.set(key, {
      id: user_id,
      active: true,
      valid_until,
      is_master: false
    });

    await kv.sadd("users:list", user_id);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("addUser error", err);
    return res.status(500).json({ ok: false });
  }
}

export const config = { api: { bodyParser: true } };
