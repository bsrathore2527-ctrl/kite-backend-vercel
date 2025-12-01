import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const user_id = req.query.user_id;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    const ts = await kv.get(`u:${user_id}:last_login`);

    return res.json({
      ok: true,
      last_login: ts || null,
      user_id
    });

  } catch (err) {
    console.error("last-login error:", err);
    return res.json({ ok: false, error: "Server error" });
  }
}
