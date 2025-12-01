import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const access = await kv.get("master:access_token");

    if (!access) {
      return res.json({
        ok: true,
        connected: false,
        reason: "no_token"
      });
    }

    // Live API check
    const resp = await fetch("https://api.kite.trade/user/profile", {
      headers: {
        "X-Kite-Version": "3",
        Authorization: "token " + process.env.KITE_API_KEY + ":" + access
      }
    });

    if (!resp.ok) {
      return res.json({
        ok: true,
        connected: false,
        reason: "invalid_token"
      });
    }

    const data = await resp.json();

    return res.json({
      ok: true,
      connected: true,
      user_id: data?.data?.user_id,
      user_name: data?.data?.user_name,
      profile: data?.data
    });

  } catch (err) {
    console.error("master-status live check error:", err);
    return res.json({
      ok: true,
      connected: false,
      reason: "error",
    });
  }
}
