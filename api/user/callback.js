// /api/user/callback.js
import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { request_token } = req.query;

    if (!request_token) {
      return res.status(400).send("Missing request_token");
    }

    // Retrieve the user who initiated login
    const userId = await kv.get("pending_login_user");
    if (!userId) {
      return res.status(400).send("No pending login user found");
    }

    // Clean pending login
    await kv.delete("pending_login_user");

    // Exchange token
    const session = await exchangeRequestTokenUser(request_token);

    if (!session || !session.access_token) {
      return res.status(500).send("Failed to generate Zerodha session");
    }

    // Store multi-user tokens
    await kv.set(`user:${userId}:token`, session.access_token);
    await kv.set(`user:${userId}:info`, session);
    await kv.set(`user:${userId}:state`, {
      connected: true,
      updated_at: Date.now()
    });

    // Redirect back to dashboard
    return res.redirect(`/user.html?login=success&user_id=${userId}`);

  } catch (err) {
    return res.status(500).send(err.message);
  }
}
