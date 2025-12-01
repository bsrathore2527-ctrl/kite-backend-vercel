import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const userIds = await kv.smembers("users:list");

    if (!userIds || userIds.length === 0) {
      return res.status(200).json({ ok: true, users: [] });
    }

    const users = [];
    for (const uid of userIds) {
      const profile = await kv.get(`u:${uid}:profile`);
      users.push({ id: uid, profile: profile || null });
    }

    return res.status(200).json({ ok: true, users });

  } catch (err) {
    console.error("listUsers error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
