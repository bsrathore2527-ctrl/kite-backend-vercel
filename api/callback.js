// /api/callback.js
import { exchangeRequestToken } from "./_lib/kite.js";
import { kv } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const { request_token, status } = req.query;

    // If Zerodha returned an error
    if (status === "error") {
      return res.redirect("/admin.html?connected=0&reason=zerodha_error");
    }

    if (!request_token) {
      return res.redirect("/admin.html?connected=0&reason=no_request_token");
    }

    // Exchange request_token → access_token
    const session = await exchangeRequestToken(request_token);

    if (!session || !session.access_token) {
      console.error("Missing access token. Session:", session);
      return res.redirect("/admin.html?connected=0&reason=exchange_failed");
    }

    const { user_id, access_token } = session;

    // Clear old master keys
    await kv.del("master:access_token");
    await kv.del("master:user_id");

    // Save new master session
    await kv.set("master:access_token", access_token);
    await kv.set("master:user_id", user_id);
    await kv.set("master:last_login_at", Date.now());

    // OPTIONAL: Save master profile for display (not required for system)
    await kv.set("master:profile", {
      user_id,
      logged_in_at: Date.now(),
    });

    console.log("Master login OK:", user_id);

    return res.redirect("/admin.html?connected=1");

  } catch (err) {
    console.error("Master callback fatal error:", err);
    return res.redirect("/admin.html?connected=0&reason=exception");
  }
}
