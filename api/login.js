// api/login.js
// Zerodha Kite OAuth login — opens browser redirect for user.

import { KiteConnect } from "kiteconnect";
// api/login.js

export default async function handler(req, res) {
  try {
    const api_key = process.env.KITE_API_KEY;
    if (!api_key) {
      return res.status(500).json({ ok: false, error: "KITE_API_KEY not set" });
    }

    // 🔥 TEMP TEST USER (later comes from DB / zid)
    const TEST_APP_USER_ID = "test_user_001";

    const loginUrl =
      "https://kite.zerodha.com/connect/login" +
      "?v=3" +
      `&api_key=${encodeURIComponent(api_key)}` +
      `&state=${encodeURIComponent(TEST_APP_USER_ID)}`;

    // Your frontend expects JSON → KEEP THIS
    return res.status(200).json({
      ok: true,
      url: loginUrl
    });
  } catch (err) {
    console.error("Login error:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
}

