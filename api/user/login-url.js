import { kv } from "../_lib/kv.js";
import { getUserLoginUrl } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id;

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // Load all users
    const users = (await kv.get("users:list")) || [];

    // Verify user exists
    const user = users.find((u) => u.id === user_id);
    if (!user) {
      return res.status(401).json({ ok: false, error: "Not an authorized user" });
    }

    // Check validity
    if (user.expired || (user.valid_until && Date.now() > user.valid_until)) {
      return res.status(403).json({
        ok: false,
        error: "User subscription expired",
      });
    }

    // Build callback URL dynamically
    const callbackRedirect = `${process.env.APP_URL}/api/user/callback?user_id=${user_id}`;

    // Build login URL via helper
    const loginUrl = getUserLoginUrl(user_id, callbackRedirect);

    return res.status(200).json({
      ok: true,
      url: loginUrl,
    });

  } catch (err) {
    console.error("login-url error:", err);
    return res.status(500).json({
      ok: false,
      error: err.message,
    });
  }
}
