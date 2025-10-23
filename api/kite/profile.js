// api/kite/profile.js
import { KiteConnect } from "kiteconnect";
import { kv, todayKey } from "../api/_lib/kv.js";

export default async function handler(req, res) {
  try {
    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};
    const token = state.access_token || state.accessToken;
    const apiKey = process.env.KITE_API_KEY;

    if (!token || !apiKey) {
      return res.status(401).json({ ok: false, error: "Missing api_key or access_token." });
    }

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(token);
    const profile = await kc.getProfile();

    res.status(200).json({ ok: true, profile });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
