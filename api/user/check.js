// File: /api/user/check.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "GET only" });
    }

    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // Load user list
    let users = await kv.get("users:list");
    if (!Array.isArray(users)) users = [];

    const user = users.find(u => u.id === user_id);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not registered"
      });
    }

    // Subscription validity
    const now = Date.now();
    const expired = !user.valid_until || now > user.valid_until;

    // Access token check
    const tokenKey = `kite:access_token:${user_id}`;
    const access_token = await kv.get(tokenKey);

    const connected = !!access_token;

    // Prepare response
    return res.status(200).json({
      ok: true,
      user: {
        id: user_id,
        valid_until: user.valid_until,
        expired,
        connected,
        last_login: await kv.get(`u:${user_id}:last_login`) || null
      }
    });

  } catch (err) {
    console.error("USER CHECK ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
