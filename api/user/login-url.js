// File: /api/user/login-url.js

import { kv } from "../_lib/kv.js";
import { getUserLoginUrl } from "../_lib/kite-user.js";

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
        error: "User not found. Contact admin."
      });
    }

    // Check subscription validity
    if (!user.valid_until || Date.now() > user.valid_until) {
      return res.status(403).json({
        ok: false,
        error: "Subscription expired"
      });
    }

    // Your USER APP redirect URL
    const redirectUrl = process.env.USER_REDIRECT_URL;

    if (!redirectUrl) {
      console.error("Missing USER_REDIRECT_URL in env");
      return res.status(500).json({
        ok: false,
        error: "Server config error"
      });
    }

    // Build Zerodha login URL for this user
    const loginUrl = getUserLoginUrl(user_id, redirectUrl);

    return res.status(200).json({
      ok: true,
      login_url: loginUrl
    });

  } catch (err) {
    console.error("USER LOGIN-URL ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Internal server error"
    });
  }
}
