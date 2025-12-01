// /api/user/login-url.js
import { kv } from "../_lib/kv.js";
import { getUserLoginUrl } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { user_id } = req.query;

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // Store user temporarily
    await kv.set("pending_login_user", user_id);

    const callbackRedirect = `${process.env.APP_URL}/api/user/callback`;
    const url = getUserLoginUrl(callbackRedirect);

    // IMPORTANT: return login_url (frontend expects this)
    return res.json({ ok: true, login_url: url });

  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message });
  }
}
