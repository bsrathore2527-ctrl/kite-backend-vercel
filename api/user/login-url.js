// File: /api/user/login-url.js
import { kv } from "@vercel/kv";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const { user_id } = req.query;
    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    // Load user list
    let users = await kv.get("users:list");
    if (!Array.isArray(users)) users = [];

    // Find the user entry
    const user = users.find(u => u.id === user_id);

    if (!user) {
      return res.status(404).json({
        ok: false,
        error: "User not found or not registered"
      });
    }

    // Check subscription validity
    if (!user.valid_until || Date.now() > user.valid_until) {
      return res.status(403).json({
        ok: false,
        error: "Subscription expired for this user"
      });
    }

    // Build login URL
    const api_key = process.env.USER_API_KEY;
    const redirect = process.env.USER_REDIRECT_URL;

    const loginUrl =
      `https://kite.trade/connect/login?v=3&api_key=${api_key}&state=${user_id}`;

    return res.status(200).json({
      ok: true,
      login_url: loginUrl
    });

  } catch (err) {
    console.error("USER LOGIN URL ERROR:", err);
    return res.status(500).json({
      ok: false,
      error: "Server error generating login URL"
    });
  }
}
