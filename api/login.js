// api/login.js
import { KiteConnect } from "kiteconnect";

const API_KEY = process.env.KITE_API_KEY;
const POST_LOGIN_REDIRECT = process.env.POST_LOGIN_REDIRECT || "/admin.html";

export default async function handler(req, res) {
  try {
    // Accept only GET (so clicking a link works)
    if (req.method !== "GET") {
      res.setHeader("Allow", "GET");
      return res.status(405).json({ ok: false, error: "Method not allowed. Use GET." });
    }

    if (!API_KEY) {
      return res.status(500).json({ ok: false, error: "Missing KITE_API_KEY env var" });
    }

    // Build the login URL using KiteConnect
    const kc = new KiteConnect({ api_key: API_KEY });
    // The login URL needs an exact redirect URL that's registered in Kite developer console:
    // e.g. https://<your-domain>/api/callback
    const redirectTo = process.env.KITE_REDIRECT_URI || `${req.headers.origin || ""}/api/callback`;
    const loginUrl = kc.getLoginURL(redirectTo);

    // Redirect the browser to Kite login
    res.writeHead(302, { Location: loginUrl });
    res.end();
  } catch (err) {
    console.error("login error:", err);
    return res.status(500).json({ ok: false, error: err.message || "Login failed" });
  }
}
