import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const ids = await kv.smembers("users:list");

    const users = [];
    for (const id of ids) {
      const profile = await kv.get(`u:${id}:profile`);
      users.push({ id, profile: profile || null });
    }

    res.json({ ok: true, users });

  } catch (err) {
    console.error("listUsers error", err);
    res.status(500).json({ ok: false });
  }
}
