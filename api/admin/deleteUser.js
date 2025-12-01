import { kv } from "../_lib/kv.js";

export default async function handler(req, res) {
  try {
    const token = req.headers["x-admin-token"];
    if (!token || token !== process.env.ADMIN_TOKEN)
      return res.status(401).json({ ok: false, error: "Unauthorized" });

    const { user_id } = req.body;

    await kv.srem("users:list", user_id);
    await kv.del(`u:${user_id}:profile`);
    await kv.del(`positions:${user_id}`);
    await kv.del(`watchlist:${user_id}`);
    await kv.del(`state:${user_id}`);
    await kv.del(`trip:${user_id}`);

    res.json({ ok: true });

  } catch (err) {
    console.error("deleteUser error", err);
    res.status(500).json({ ok: false });
  }
}

export const config = { api: { bodyParser: true } };
