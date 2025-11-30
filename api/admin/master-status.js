import { kv } from "../_lib/kv.js";


const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    // Validate admin token
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Load master session
    const session = await redis.get("master:zerodha:session");

    if (!session) {
      return res.status(200).json({
        ok: true,
        connected: false,
        status: "Not Connected",
      });
    }

    const { user_id, last_login_at } = session;

    return res.status(200).json({
      ok: true,
      connected: true,
      user_id,
      last_login_at,
      status: `Connected as ${user_id}`,
    });

  } catch (err) {
    console.error("master-status error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
