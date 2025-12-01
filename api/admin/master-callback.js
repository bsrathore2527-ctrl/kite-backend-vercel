// File: /api/admin/master-callback.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    console.log("MASTER CALLBACK HIT", req.query);

    const { request_token, status } = req.query;

    if (status !== "success") {
      return res.redirect("/admin.html?master=failed");
    }

    if (!request_token) {
      console.log("Missing request_token for master login");
      return res.redirect("/admin.html?master=failed");
    }

    // Exchange token
    const api_key = process.env.KITE_API_KEY;
    const api_secret = process.env.KITE_API_SECRET;

    const crypto = await import("crypto");
    const checksum = crypto.createHash("sha256")
      .update(`${api_key}${request_token}${api_secret}`)
      .digest("hex");

    // Request access token
    const resp = await fetch("https://api.kite.trade/session/token", {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body: new URLSearchParams({
        api_key,
        request_token,
        checksum
      })
    });

    const data = await resp.json();

    if (!data?.data?.access_token) {
      console.log("Master token exchange failed", data);
      return res.redirect("/admin.html?master=failed");
    }

    const {
      access_token,
      user_id,
      login_time,
      user_name,
      email,
      user_type
    } = data.data;

    // Save master tokens in Redis
    await kv.set("master:access_token", access_token);
    await kv.set("master:user_id", user_id);
    await kv.set("master:last_login_at", Date.now());
    await kv.set("master:profile", {
      user_id,
      user_name,
      email,
      user_type,
      login_time
    });

    console.log("Master login saved successfully:", user_id);

    return res.redirect("/admin.html?master=success");

  } catch (err) {
    console.log("MASTER CALLBACK ERROR:", err);
    return res.redirect("/admin.html?master=failed");
  }
}
