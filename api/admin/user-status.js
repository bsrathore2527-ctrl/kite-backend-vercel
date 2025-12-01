import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const user_id = req.query.user_id;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // Get access token saved during login
    const access = await kv.get(`kite:access_token:${user_id}`);

    if (!access) {
      return res.json({
        ok: true,
        connected: false,
        reason: "no_token",
        user_id
      });
    }

    // LIVE ZERODHA CALL for the user
    const resp = await fetch("https://api.kite.trade/user/profile", {
      headers: {
        "X-Kite-Version": "3",
        Authorization:
          "token " + process.env.USER_API_KEY + ":" + access
      }
    });

    if (!resp.ok) {
      return res.json({
        ok: true,
        connected: false,
        reason: "invalid_token",
        user_id
      });
    }

    const data = await resp.json();

    return res.json({
      ok: true,
      connected: true,
      user_id,
      broker_user_id: data?.data?.user_id,
      name: data?.data?.user_name
    });

  } catch (err) {
    console.error("user-status error:", err);

    return res.json({
      ok: true,
      connected: false,
      reason: "error",
      user_id: req.query.user_id || null
    });
  }
}
