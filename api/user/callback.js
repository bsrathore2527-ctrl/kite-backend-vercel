// /api/user/callback.js   DEBUG VERSION
import { kv } from "../_lib/kv.js";
import { exchangeRequestTokenUser } from "../_lib/kite-user.js";

async function logDebug(message, data = null) {
  const entry = {
    time: new Date().toISOString(),
    message,
    data
  };

  const logs = await kv.get("debug:callback") || [];
  logs.push(entry);

  await kv.set("debug:callback", logs);
}

export default async function handler(req, res) {
  try {
    await logDebug("CALLBACK HIT", { query: req.query });

    const { request_token, status, state } = req.query;
    const user_id = state;  // expected

    // Log extracted parameters
    await logDebug("Parsed Params", { request_token, status, user_id });

    if (status === "error") {
      await logDebug("Status returned error");
      return res.redirect("/user.html?login=failed");
    }

    // Validate presence of required fields
    if (!request_token) {
      await logDebug("Missing request_token!");
      return res.redirect("/user.html?login=failed&reason=missing_rt");
    }

    if (!user_id) {
      await logDebug("Missing user_id! STATE NOT ARRIVING");
      return res.redirect("/user.html?login=failed&reason=missing_uid");
    }

    const profile = await kv.get(`user:${user_id}`);
    if (!profile) {
      await logDebug("Profile missing for user!", { user_id });
      return res.redirect("/user.html?login=failed&reason=no_profile");
    }

    await logDebug("Profile Loaded", profile);

    // Exchange request token using user API key/secret
    await logDebug("Attempting exchangeRequestTokenUser() NOW");

    const session = await exchangeRequestTokenUser(
      request_token,
      profile.api_key,
      profile.api_secret
    );

    await logDebug("Exchange Response", session);

    if (!session || !session.access_token) {
      await logDebug("Exchange FAILED. No access_token.", session);
      return res.redirect("/user.html?login=failed&reason=exchange_failed");
    }

    // Save KV data
    await kv.set(`user:${user_id}:access_token`, session.access_token);
    await kv.set(`user:${user_id}:last_login`, Date.now());

    await logDebug("LOGIN SUCCESS", {
      saved_token: session.access_token
    });

    return res.redirect(`/user.html?uid=${user_id}&login=success`);

  } catch (e) {
    console.error("user callback error:", e);
    await logDebug("CRASHED", { error: e.toString() });
    return res.redirect("/user.html?login=error&reason=exception");
  }
}

export const config = { api: { bodyParser: false } };
