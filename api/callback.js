import { exchangeRequestToken } from "./_lib/kite.js";
import { getAccessToken, setAccessToken, kv } from "./_lib/kv.js";

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
      console.error("Master session missing access token");
      return res.redirect("/admin.html?connected=0");
    }

    const { user_id, access_token, public_token, enctoken } = session;

    // Save master session (Option A)
    await kv.set("master:zerodha:session", {
      user_id,
      access_token,
      public_token,
      enctoken,
      last_login_at: Date.now(),
    });

    // Auto-register master as a system user
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

    // Redirect back to admin panel
    return res.redirect("/admin.html?connected=1");

  } catch (err) {
    console.error("callback error:", err);
    return res.redirect("/admin.html?connected=0");
  }
}
