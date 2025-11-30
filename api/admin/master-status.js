import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Load master session from KV
    const session = await kv.get("master:zerodha:session");

    if (!session) {
      return res.status(200).json({
        ok: true,
        connected: false,
        status: "Not Connected",
      });
    }

    return res.status(200).json({
      ok: true,
      connected: true,
      user_id: session.user_id,
      last_login_at: session.last_login_at,
      status: `Connected as ${session.user_id}`,
    });

  } catch (err) {
    console.error("master-status error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
