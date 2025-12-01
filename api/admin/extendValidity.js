// File: /api/admin/extendValidity.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST")
      return res.status(405).json({ ok: false, error: "POST only" });

    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id, days } = req.body;
    if (!user_id || !days)
      return res.status(400).json({ ok: false, error: "Missing fields" });

    const uid = user_id.toUpperCase().trim();

    // Load list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) list = [];

    const user = list.find(u => u.id === uid);
    if (!user)
      return res.json({ ok: false, error: "User not found" });

    const addMs = Number(days) * 24 * 60 * 60 * 1000;
    user.valid_until = (user.valid_until || Date.now()) + addMs;

    await kv.set("users:list", list);

    return res.json({ ok: true, user });

  } catch (err) {
    console.error("EXTEND VALIDITY ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
