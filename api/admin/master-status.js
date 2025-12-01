import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Load master session
    const session = await kv.get("master:zerodha:session");

    if (!session) {
      return res.status(200).json({
        ok: true,
        connected: false,
        status: "Not Connected",
      });
    }

    const { access_token, user_id } = session;

    // Validate token with Zerodha API
    const profileRes = await fetch("https://api.kite.trade/user/profile", {
      headers: {
        "X-Kite-Version": "3",
        Authorization: `token ${process.env.KITE_API_KEY}:${access_token}`,
      },
    });

    // If Zerodha rejected token → expired
    if (!profileRes.ok) {
      return res.status(200).json({
        ok: true,
        connected: false,
        status: "Token Expired — Please Login Again",
      });
    }

    // VALID TOKEN → connected
    return res.status(200).json({
      ok: true,
      connected: true,
      user_id,
      status: `Connected as ${user_id}`,
    });

  } catch (err) {
    console.error("master-status error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
