// File: /api/admin/master-status.js

import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    if (req.method !== "GET") {
      return res.status(405).json({ ok: false, error: "GET only" });
    }

    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const access = await kv.get("kite:access_token:MASTER");

    return res.json({
      ok: true,
      connected: !!access,
      access_token: access || null
    });

  } catch (err) {
    console.error("MASTER STATUS ERROR:", err);
    return res.status(500).json({ ok: false, error: "Server error" });
  }
}
