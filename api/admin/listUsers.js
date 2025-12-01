// /api/admin/listUsers.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST") {
    return res.status(405).json({ ok: false, error: "POST only" });
  }

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN) {
    return res.status(401).json({ ok: false, error: "Unauthorized" });
  }

  try {
    // Load user list
    let list = await kv.get("users:list");

    // Auto-heal if corrupted or missing
  if (!Array.isArray(list)) list = [];
    

    const users = [];

    for (const id of list) {
      // Load profile safely
      let profile = await kv.get(`user:${id}`);
      if (!profile || typeof profile !== "object") {
        profile = { active: false, valid_until: 0 };
      }

      // Check access token for connected status
      const access = await kv.get(`user:${id}:access_token`);
      const connected = !!access;

      users.push({
        id,
        profile,
        connected, // ADMIN PANEL USES THIS
      });
    }

    return res.json({ ok: true, users });

  } catch (err) {
    console.error("listUsers.js error:", err);
    return res.status(500).json({ ok: false, error: err.toString() });
  }
}

export const config = { api: { bodyParser: true } };
