// api/login.js
// Zerodha Kite OAuth login — opens browser redirect for user.

import { KiteConnect } from "kiteconnect";
// api/login.js

// api/login.js
export default function handler(req, res) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ ok: false, error: "KITE_API_KEY missing" });
  }

  // TEMP test value
  const state = "test_user_001";

  const loginUrl =
    "https://kite.zerodha.com/connect/login" +
    "?v=3" +
    `&api_key=${encodeURIComponent(apiKey)}` +
    `&state=${encodeURIComponent(state)}`;

  return res.json({ ok: true, url: loginUrl });
}


