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

    // remove from users list
    await kv.srem("users:list", user_id);

    // delete keys
    await kv.del(`u:${user_id}:profile`);
    await kv.del(`positions:${user_id}`);
    await kv.del(`watchlist:${user_id}`);
    await kv.del(`state:${user_id}`);
    await kv.del(`trip:${user_id}`);

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error("deleteUser error:", err);
    return res.status(500).json({ ok: false, error: "Server Error" });
  }
}
