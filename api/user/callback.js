// File: /api/user/callback.js

import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { request_token, status, state } = req.query;

    // 1) Basic validation from Zerodha
    if (status === "error") {
      console.error("USER CALLBACK: Zerodha returned error status");
      return res.redirect("/user.html?login=failed&reason=zerodha_error");
    }

    if (!request_token) {
      console.error("USER CALLBACK: Missing request_token");
      return res.redirect("/user.html?login=failed&reason=no_request_token");
    }

    if (!state) {
      console.error("USER CALLBACK: Missing state (user_id)");
      return res.redirect("/user.html?login=failed&reason=no_state");
    }

    const user_id = state.trim().toUpperCase();

    // 2) Verify that user exists and is valid (from users:list)
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) {
      console.warn("USER CALLBACK: users:list was not array, resetting");
      list = [];
      await kv.set("users:list", list);
    }

    const user = list.find(u => u.id === user_id);
    if (!user) {
      console.error("USER CALLBACK: User not found in list", user_id);
      return res.redirect("/user.html?login=failed&reason=user_not_registered");
    }

    const now = Date.now();
    if (!user.valid_until || now > user.valid_until) {
      console.error("USER CALLBACK: Subscription expired for", user_id);
      return res.redirect("/user.html?login=failed&reason=expired");
    }

    // 3) Exchange request_token -> access_token using USER APP
    const session = await exchangeRequestTokenUser(request_token);

    if (!session || !session.access_token) {
      console.error("USER CALLBACK: Token exchange failed. Session:", session);
      return res.redirect("/user.html?login=failed&reason=exchange_failed");
    }

    const access_token = session.access_token;

    // 4) Save access token and last login in KV
    await kv.set(`kite:access_token:${user_id}`, access_token);
    await kv.set(`u:${user_id}:last_login`, now);

    console.log("USER CALLBACK: Login success for", user_id);

    // 5) Redirect to user panel
    return res.redirect(`/user.html?login=success&uid=${encodeURIComponent(user_id)}`);

  } catch (err) {
    console.error("USER CALLBACK EXCEPTION:", err);
    return res.redirect("/user.html?login=failed&reason=exception");
  }
}
