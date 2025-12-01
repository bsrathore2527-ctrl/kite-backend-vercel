// /api/user/login-url.js
import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  try {
    const { user_id } = req.body;
    if (!user_id) return res.json({ ok: false, error: "Missing user_id" });

    const profile = await kv.get(`user:${user_id}`);
    if (!profile || !profile.api_key)
      return res.json({ ok: false, error: "User not signed up" });

    const api_key = profile.api_key;

    const url =
      "https://kite.zerodha.com/connect/login?v=3&api_key=" + api_key;

    return res.json({ ok: true, url });

  } catch (e) {
    console.error("login-url.js error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
