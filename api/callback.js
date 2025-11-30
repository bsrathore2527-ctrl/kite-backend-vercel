import { exchangeRequestToken } from "./_lib/kite.js";
import { kv } from "./_lib/kv.js";

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
      console.error("Master session missing access token:", session);
      return res.redirect("/admin.html?connected=0");
    }

    const { user_id, access_token, public_token, enctoken } = session;

    // Save unified master session
    await kv.set("master:zerodha:session", {
      user_id,
      access_token,
      public_token,
      enctoken,
      last_login_at: Date.now(),
    });

    // Auto-register master as system user
    const profileKey = `u:${user_id}:profile`;
    const existingProfile = await kv.get(profileKey);

    if (!existingProfile) {
      await kv.set(profileKey, {
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
