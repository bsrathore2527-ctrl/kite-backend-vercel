// api/login.js — start OAuth flow
import { loginUrl } from "./_lib/kite.js";

export default async function handler(req, res) {
  try {
    const url = loginUrl();
    res.writeHead(302, { Location: url });
    res.end();
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || "Login init failed" });
  }
}
