// File: /api/admin/deleteUser.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, error: "POST only" });

    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id } = req.body;
    if (!user_id)
      return res.status(400).json({ ok: false, error: "Missing user_id" });

    const uid = user_id.toUpperCase().trim();

    // Load list safely
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    const newList = list.filter(u => u.id !== uid);

    await kv.set("users:list", newList);

    // Cleanup associated KV keys
    await kv.del(`kite:access_token:${uid}`);
    await kv.del(`u:${uid}:last_login`);

    return res.json({ ok: true, deleted: uid });

  } catch (err) {
    console.error("DELETE USER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
