import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  if (req.method !== "POST")
    return res.status(405).json({ ok: false, error: "POST only" });

  const token = req.headers["x-admin-token"];
  if (!token || token !== process.env.ADMIN_TOKEN)
    return res.status(401).json({ ok: false, error: "Unauthorized" });

  try {
    const { user_id } = req.body;

    let list = await kv.get("users:list");

    // Repair list if corrupted
    if (!Array.isArray(list)) list = [];

    list = list.filter(u => u !== user_id);
    await kv.set("users:list", list);

    // Remove entire user data safely
    await kv.del(`user:${user_id}`);
    await kv.del(`user:${user_id}:config`);
    await kv.del(`user:${user_id}:state`);

    return res.json({ ok: true });

  } catch (e) {
    console.error("deleteUser error:", e);
    return res.status(500).json({ ok: false, error: e.toString() });
  }
}

export const config = { api: { bodyParser: true } };
