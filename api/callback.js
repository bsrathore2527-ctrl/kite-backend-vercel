// api/callback.js — handle request_token -> access_token
import { exchangeRequestToken } from "./_lib/kite.js";

// api/callback.js

export default async function handler(req, res) {
  try {
    const { request_token, state } = req.query || {};

    // 🔽 ADD THIS
    console.log("Zerodha callback state:", state);

    if (!request_token) {
      return res.status(400).json({
        ok: false,
        error: "Missing request_token",
        state
      });
    }

    await exchangeRequestToken(request_token);

    const redirectTo = process.env.POST_LOGIN_REDIRECT || "/admin.html";
    res.writeHead(302, { Location: redirectTo });
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Auth failed" });
  }
}
