import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { user_id, valid_until } = req.body;
    if (!user_id || !valid_until)
      return res.json({ ok: false, error: "Missing fields" });

    // Load user list safely
    let list = await kv.get("users:list");

    // Auto-recovery if corrupted
    if (!Array.isArray(list)) list = [];

    // Avoid duplicate entries
    if (!list.includes(user_id)) {
      list.push(user_id);
      await kv.set("users:list", list);
    }

    // Create user profile safely
    await kv.set(`user:${user_id}`, {
      active: true,
      valid_until,
      created_at: Date.now()
    });

    return res.json({ ok: true });

  } catch (e) {
    console.error("addUser error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
