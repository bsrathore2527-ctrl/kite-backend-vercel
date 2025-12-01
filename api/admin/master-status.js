import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const access = await kv.get("master:access_token");
    const uid = await kv.get("master:user_id");

    if (!access || !uid)
      return res.json({ ok: true, status: "Not Connected" });

    return res.json({ ok: true, status: `Connected as ${uid}` });

  } catch (e) {
    console.error("master-status error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
