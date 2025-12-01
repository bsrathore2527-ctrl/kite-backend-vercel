import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const uid = req.query.user_id || "ZD5101";

    const info = await kv.get(`user:${uid}:info`);
    const state = await kv.get(`user:${uid}:state`);
    const token = await kv.get("kite:current:token");
    const userList = await kv.get("users:list");

    return res.status(200).json({
      user_list: userList,
      info_key: `user:${uid}:info`,
      info,
      state_key: `user:${uid}:state`,
      state,
      current_token: token
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
