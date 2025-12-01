// File: /api/user/callback.js

import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const { request_token, status } = req.query;

    // 🔥 DEVELOPMENT MODE: HARD-CODE USER ID
    const user_id = "ZD5101"; 
    console.log("🔧 DEV MODE CALLBACK USING FIXED USER:", user_id);

    // Step 1: Basic validation
    if (status === "error") {
      console.error("USER CALLBACK: Zerodha returned error status");
      return res.redirect("/user.html?login=failed&reason=zerodha_error");
    }

    if (!request_token) {
      console.error("USER CALLBACK: Missing request_token");
      return res.redirect("/user.html?login=failed&reason=no_request_token");
    }

    // Step 2: Ensure user exists in KV list
    let list = await kv.get("users:list");
    if (!Array.isArray(list)) {
      console.warn("users:list was not an array — resetting");
      list = [];
      await kv.set("users:list", list);
    }

    const user = list.find(u => u.id === user_id);
    if (!user) {
      console.error("USER CALLBACK: User not in list", user_id);
      return res.redirect("/user.html?login=failed&reason=user_not_registered");
    }

    if (Date.now() > user.valid_until) {
      console.error("USER CALLBACK: Subscription expired for", user_id);
      return res.redirect("/user.html?login=failed&reason=expired");
    }

    // Step 3: Exchange request_token → access_token
    const session = await exchangeRequestTokenUser(request_token);

    if (!session || !session.access_token) {
      console.error("USER CALLBACK: Token exchange failed", session);
      return res.redirect("/user.html?login=failed&reason=exchange_failed");
    }

    const access_token = session.access_token;

    // Step 4: Save to KV
    await kv.set(`kite:access_token:${user_id}`, access_token);
    await kv.set(`u:${user_id}:last_login`, Date.now());

    console.log("USER CALLBACK: Login success for", user_id);

    // Step 5: Redirect to user page
    return res.redirect(
      `/user.html?login=success&uid=${encodeURIComponent(user_id)}`
    );

  } catch (err) {
    console.error("USER CALLBACK EXCEPTION:", err);
    return res.redirect("/user.html?login=failed&reason=exception");
  }
}
