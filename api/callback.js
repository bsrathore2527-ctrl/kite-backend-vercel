import { kv } from "@vercel/kv";
import crypto from "crypto";

export default async function handler(req, res) {
  try {
    const { request_token, status } = req.query;

    if (status === "error") {
      return res.redirect("/admin.html?connected=0");
    }

    if (!request_token) {
      return res.status(400).send("Missing request_token");
    }

    const apiKey = process.env.KITE_API_KEY;
    const apiSecret = process.env.KITE_API_SECRET;

    if (!apiKey || !apiSecret) {
      return res.status(500).send("API KEY/SECRET not configured");
    }

    // Compute checksum SHA256(api_key + request_token + api_secret)
    const checksum = crypto
      .createHash("sha256")
      .update(apiKey + request_token + apiSecret)
      .digest("hex");

    // Exchange request_token → access_token
    const sessionRes = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/x-www-form-urlencoded",
        "X-Kite-Version": "3"
      },
      body: new URLSearchParams({
        api_key: apiKey,
        request_token,
        checksum
      })
    });

    const data = await sessionRes.json();

    if (!data?.data?.access_token) {
      console.error("Token exchange failed:", data);
      return res.redirect("/admin.html?connected=0");
    }

    // Extract master info
    const { access_token, public_token, user_id } = data.data;

    // -------------------------------------------
    // 🔥 Extract ENCTOKEN from Set-Cookie headers
    // -------------------------------------------
    const rawSetCookie = sessionRes.headers.get("set-cookie") || "";
    const enctoken = extractEnctoken(rawSetCookie);

    if (!enctoken) {
      console.error("Enctoken missing in cookie header!");
      return res.redirect("/admin.html?connected=0");
    }

    // -------------------------------------------
    // Save master session in Redis
    // -------------------------------------------
    await kv.set("master:zerodha:session", {
      user_id,
      access_token,
      public_token,
      enctoken,
      last_login_at: Date.now()
    });

    // -------------------------------------------
    // Auto-register master as system user
    // -------------------------------------------
    const profileKey = `u:${user_id}:profile`;

    const existing = await kv.get(profileKey);

    if (!existing) {
      await kv.set(profileKey, {
        id: user_id,
        is_master: true,
        valid_until: 9999999999999,
        active: true
      });
    }

    // Redirect back to admin panel
    return res.redirect("/admin.html?connected=1");

  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect("/admin.html?connected=0");
  }
}

// -------------------------------------------
// Helper to extract enctoken from cookie
// -------------------------------------------
function extractEnctoken(cookieStr) {
  const match = cookieStr.match(/enctoken=([^;]+)/);
  return match ? match[1] : null;
}
