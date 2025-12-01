// File: /api/user/callback.js
import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js"; // we will create this next

export default async function handler(req, res) {
  try {
    const { request_token, status, state } = req.query;

    // Reject on Zerodha error
    if (status === "error") {
      return res.redirect("/user.html?login=failed&reason=zerodha_error");
    }

    if (!request_token) {
      return res.redirect("/user.html?login=failed&reason=no_request_token");
    }

    if (!state) {
      return res.redirect("/user.html?login=failed&reason=no_state");
    }

    const user_id = state;

    // Validate user
    let users = await kv.get("users:list");
    if (!Array.isArray(users)) users = [];

    const user = users.find(u => u.id === user_id);
    if (!user) {
      return res.redirect("/user.html?login=failed&reason=not_registered");
    }

    if (!user.valid_until || Date.now() > user.valid_until) {
      return res.redirect("/user.html?login=failed&reason=expired");
    }

    // Exchange request token using USER API KEY + SECRET
    const session = await exchangeRequestTokenUser(request_token);

    if (!session || !session.access_token) {
      console.error("USER LOGIN FAILED: session =", session);
      return res.redirect("/user.html?login=failed&reason=exchange_failed");
    }

    const { access_token } = session;

    // Save in KV
    await kv.set(`kite:access_token:${user_id}`, access_token);
    await kv.set(`u:${user_id}:last_login`, Date.now());

    console.log("USER LOGIN OK:", user_id);

    return res.redirect("/user.html?login=success");

  } catch (err) {
    console.error("User callback error:", err);
    return res.redirect("/user.html?login=failed&reason=exception");
  }
}
