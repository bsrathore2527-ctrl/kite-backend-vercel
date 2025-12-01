// /api/debug-login.js
import { kv } from "./_lib/kv.js";
import { getUserLoginUrl } from "./_lib/kite-user.js";

export default async function handler(req, res) {
  try {
    const user_id = req.query.user_id;

    const APP_URL = process.env.APP_URL;
    const API_KEY = process.env.USER_API_KEY;
    const API_SECRET = process.env.USER_API_SECRET;

    const users = await kv.get("users:list");

    const callbackRedirect = APP_URL
      ? `${APP_URL}/api/user/callback`
      : null;

    let builtURL = null;
    let urlError = null;

    try {
      if (callbackRedirect) {
        builtURL = getUserLoginUrl(callbackRedirect);
      } else {
        urlError = "APP_URL undefined - cannot build URL";
      }
    } catch (err) {
      urlError = err.message;
    }

    return res.status(200).json({
      user_id,
      APP_URL,
      API_KEY: API_KEY ? "SET" : "MISSING",
      API_SECRET: API_SECRET ? "SET" : "MISSING",
      users,
      callbackRedirect,
      builtURL,
      urlError
    });

  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
