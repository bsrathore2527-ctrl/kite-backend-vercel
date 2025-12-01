// /api/admin/master-login.js

import { loginUrl } from "../_lib/kite.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.query.token;

    // Validate admin token
    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    // Generate Zerodha login URL using your kite.js logic
    const url = loginUrl();

    // Redirect admin to Zerodha login page
    return res.redirect(302, url);

  } catch (err) {
    console.error("master-login error:", err);
    return res.status(500).json({ ok: false, error: "Internal Server Error" });
  }
}
