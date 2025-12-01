// File: /api/admin/addUser.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "POST only" });
    }

    const adminToken = req.headers["x-admin-token"];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { user_id, days } = req.body;
    if (!user_id || !days) {
      return res.status(400).json({ ok: false, error: "Missing user_id or days" });
    }

    const uid = user_id.toUpperCase().trim();

    // Load user list safely
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) {
      console.log("⚠ Resetting corrupted users:list");
      list = [];
    }

    // Check for duplicate
    const existing = list.find(u => u.id === uid);
    if (existing) {
      return res.status(400).json({ ok: false, error: "User already exists" });
    }

    const valid_until = Date.now() + Number(days) * 24 * 60 * 60 * 1000;

    const newUser = {
      id: uid,
      valid_until,
      created_at: Date.now()
    };

    list.push(newUser);

    // Save updated list
    await kv.set("users:list", list);

    return res.status(200).json({
      ok: true,
      user: newUser,
      total: list.length
    });

  } catch (err) {
    console.error("ADD USER ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}

export const config = { api: { bodyParser: true } };
