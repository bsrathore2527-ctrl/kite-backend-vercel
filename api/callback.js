import { withCors } from "./_lib/cors.js";
import { instance, setAccessTokenCookie } from "./_lib/kite.js";
import { kv, IST } from "./_lib/kv.js";

export default withCors(async function handler(req, res) {
  try {
    const { request_token } = req.query;
    if (!request_token) {
      return res.status(400).json({ error: "Missing request_token" });
    }

    const kc = instance();
    const data = await kc.generateSession(request_token, process.env.KITE_API_SECRET);
    const accessToken = data.access_token; // also contains refresh_token, public_token

    // 1) Normal app cookie for your frontend calls
    setAccessTokenCookie(res, accessToken);

    // 2) Save today's token for cron/enforcer (Phase 1 automation)
    const today = new Date().toLocaleDateString("en-CA", { timeZone: IST }); // YYYY-MM-DD (IST)
    await kv.set(`kite_at:${today}`, accessToken, { ex: 60 * 60 * 20 }); // ~20h

    // Redirect to your frontend after successful auth
    const redirectTo =
      (req.headers.referer && req.headers.referer.startsWith("http"))
        ? req.headers.referer
        : (process.env.POST_LOGIN_REDIRECT || "/success.html");

    res.writeHead(302, { Location: redirectTo });
    res.end();
  } catch (err) {
    res.status(500).json({ error: err.message || "Auth failed", details: err });
  }
});
