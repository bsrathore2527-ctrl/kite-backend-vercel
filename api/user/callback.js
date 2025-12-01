// /api/user/callback.js
import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { request_token, status, user_id } = req.query;

    if (status === "error")
      return res.redirect("/user.html?login=failed");

    if (!request_token || !user_id)
      return res.redirect("/user.html?login=failed");

    // Load user profile
    const profile = await kv.get(`user:${user_id}`);
    if (!profile) return res.redirect("/user.html?login=failed");

    // Exchange using user's API key + secret
    const session = await exchangeRequestTokenUser(
      request_token,
      profile.api_key,
      profile.api_secret
    );

    if (!session || !session.access_token)
      return res.redirect("/user.html?login=failed");

    await kv.set(`user:${user_id}:access_token`, session.access_token);
    await kv.set(`user:${user_id}:last_login`, Date.now());

    return res.redirect(`/user.html?uid=${user_id}&login=success`);

  } catch (e) {
    console.error("user callback error:", e);
    return res.redirect("/user.html?login=error");
  }
}

export const config = { api: { bodyParser: false } };
