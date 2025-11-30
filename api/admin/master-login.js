import { loginUrl } from "../_lib/kite.js";

export default async function handler(req, res) {
  try {
    const token = req.query.token;

    if (!token || token !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Use your existing working login URL generator
    const url = loginUrl();

    // Redirect admin to Zerodha login
    res.writeHead(302, { Location: url });
    res.end();

  } catch (err) {
    console.error("master-login error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
