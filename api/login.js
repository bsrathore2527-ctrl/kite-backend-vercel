// api/login.js
// Zerodha Kite OAuth login — opens browser redirect for user.

import { KiteConnect } from "kiteconnect";

export default async function handler(req, res) {
  try {
    // Allow both GET and POST so UI and other integrations work
    if (req.method !== "GET" && req.method !== "POST") {
      return res.status(405).json({ ok: false, error: "Method not allowed" });
    }

    const api_key = process.env.KITE_API_KEY;
    if (!api_key) {
      return res.status(500).json({ ok: false, error: "KITE_API_KEY not set" });
    }

    const kc = new KiteConnect({ api_key });
    const loginUrl = kc.getLoginURL();

    // For GET: redirect the browser to Zerodha's login URL
    if (req.method === "GET") {
      res.writeHead(302, { Location: loginUrl });
      res.end();
      return;
    }

    // For POST: return the URL as JSON (optional usage)
    return res.status(200).json({ ok: true, url: loginUrl });
  } catch (err) {
    console.error("Zerodha Login Error:", err);
    res.status(500).json({ ok: false, error: err.message || "Login failed" });
  }
}
