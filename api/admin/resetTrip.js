import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const adminToken = req.headers["x-admin-token"];

    if (!adminToken || adminToken !== process.env.ADMIN_TOKEN) {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }

    const { user_id } = await req.json();

    if (!user_id) {
      return res.status(400).json({ ok: false, error: "Missing user_id" });
    }

    await kv.set(`trip:${user_id}`, false);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("resetTrip error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
