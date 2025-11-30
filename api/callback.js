import { exchangeRequestToken } from "./_lib/kite.js";
import { get as kvGet, set as kvSet } from "./_lib/kv.js";

export default async function handler(req, res) {
  try {
    const { request_token, status } = req.query;

    if (status === "error") {
      return res.redirect("/admin.html?connected=0");
    }

    if (!request_token) {
      return res.redirect("/admin.html?connected=0");
    }

    // Use your working exchange logic
    const session = await exchangeRequestToken(request_token);

    if (!session || !session.access_token) {
      console.error("Master session missing access token", session);
      return res.redirect("/admin.html?connected=0");
    }

    const { user_id, access_token, public_token, enctoken } = session;

    // Store master session as one JSON object
    await kvSet("master:zerodha:session", {
      user_id,
      access_token,
      public_token,
      enctoken,
      last_login_at: Date.now(),
    });

    // Auto-register master user for multi-user system
    const profileKey = `u:${user_id}:profile`;
    const existing = await kvGet(profileKey);

    if (!existing) {
      await kvSet(profileKey, {
        id: user_id,
        is_master: true,
        active: true,
        valid_until: 9999999999999,
      });
    }

    return res.redirect("/admin.html?connected=1");

  } catch (err) {
    console.error("Master callback error:", err);
    return res.redirect("/admin.html?connected=0");
  }
}
