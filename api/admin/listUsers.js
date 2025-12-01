// File: /api/admin/listUsers.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "GET only" });
    }

    const adminToken = req.headers["x-admin-token"];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Fetch user list
    let list = await kv.get("users:list");

    // Auto-fix corruption
    if (!Array.isArray(list)) {
      console.log("⚠ listUsers: Detected corrupted users:list. Resetting.");
      list = [];
      await kv.set("users:list", list);
    }

    return res.status(200).json({
      ok: true,
      users: list,
      total: list.length
    });

  } catch (err) {
    console.error("LIST USERS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
