import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id } = req.body;
    await kv.set(`trip:${user_id}`, false);

    res.json({ ok: true });

  } catch (err) {
    console.error("resetTrip error", err);
    res.status(500).json({ ok: false });
  }
}

export const config = { api: { bodyParser: true } };
