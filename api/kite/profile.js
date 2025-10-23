// api/kite/profile.js
import { withCors } from "../_lib/cors.js";
import { instance } from "../_lib/kite.js";

export default withCors(async function handler(req, res) {
  if (req.method !== "GET") {
    return res.status(405).json({ ok: false, error: "Method not allowed" });
  }
  try {
    const kc = instance();          // uses API key + cookie access_token
    const profile = await kc.getProfile();
    return res.json({ ok: true, profile });
  } catch (err) {
    return res.json({ ok: false, error: err?.message || String(err) });
  }
});
