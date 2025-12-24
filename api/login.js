// api/login.js
// Zerodha Kite OAuth login — opens browser redirect for user.

import { KiteConnect } from "kiteconnect";

// api/login.js
export default function handler(req, res) {
  const api_key = process.env.KITE_API_KEY;
  if (!api_key) {
    return res.status(500).send("KITE_API_KEY missing");
  }

  const TEST_APP_USER_ID = "test_user_001";

  const loginUrl =
    "https://kite.zerodha.com/connect/login" +
    "?v=3" +
    `&api_key=${encodeURIComponent(api_key)}` +
    `&state=${encodeURIComponent(TEST_APP_USER_ID)}`;

  // HARD redirect
  res.writeHead(302, { Location: loginUrl });
  res.end();
}
