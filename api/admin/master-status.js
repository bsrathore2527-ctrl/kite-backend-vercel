import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const access = await kv.get("master:access_token");
    const profile = await kv.get("master:profile");

    return res.json({
      ok: true,
      connected: !!access,
      user_id: profile?.user_id || null,
      last_login: profile?.login_time || null
    });

  } catch (err) {
    console.error("master-status error:", err);
    return res.status(500).json({ ok: false, error: "internal_error" });
  }
}
