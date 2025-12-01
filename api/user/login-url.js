// /api/user/login-url.js
import { kv } from "../_lib/kv.js";
import { getUserLoginUrl } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({
        ok: false,
        error: "Missing user_id"
      });
    }

    // Save temporarily: who is trying to log in
    await kv.set("pending_login_user", user_id);

    // Build callback URL
    const callbackRedirect = `${process.env.APP_URL}/api/user/callback`;

    // Build Zerodha login URL
    const url = getUserLoginUrl(callbackRedirect);

    return res.json({ ok: true, url });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
