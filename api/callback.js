import { Redis } from "@upstash/redis";
import crypto from "crypto";

const redis = new Redis({
  url: process.env.UPSTASH_REDIS_URL,
  token: process.env.UPSTASH_REDIS_REST_TOKEN,
});

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

    // Zerodha checksum
    const checksum = crypto
      .createHash("sha256")
      .update(apiKey + request_token + apiSecret)
      .digest("hex");

    // Exchange token
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

    const { access_token, public_token, user_id } = data.data;

    // Extract enctoken
    const setCookie = sessionRes.headers.get("set-cookie") || "";
    const enctoken = extractEnctoken(setCookie);

    if (!enctoken) {
      console.error("ENCTOKEN not found in cookie");
      return res.redirect("/admin.html?connected=0");
    }

    // Save master session
    await redis.set("master:zerodha:session", {
      user_id,
      access_token,
      public_token,
      enctoken,
      last_login_at: Date.now()
    });

    // Auto-register master user
    const profileKey = `u:${user_id}:profile`;
    const existing = await redis.get(profileKey);

    if (!existing) {
      await redis.set(profileKey, {
        id: user_id,
        is_master: true,
        valid_until: 9999999999999,
        active: true
      });
    }

    return res.redirect("/admin.html?connected=1");

  } catch (err) {
    console.error("Callback error:", err);
    return res.redirect("/admin.html?connected=0");
  }
}

function extractEnctoken(cookieStr) {
  const match = cookieStr.match(/enctoken=([^;]+)/);
  return match ? match[1] : null;
}
