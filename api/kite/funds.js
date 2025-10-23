// api/kite/funds.js
import { KiteConnect } from "kiteconnect";
import { kv, todayKey } from "../api/_lib/kv.js";

export default async function handler(req, res) {
  try {
    const key = `risk:${todayKey()}`;
    const state = (await kv.get(key)) || {};
    const token = state.access_token || state.accessToken;
    const apiKey = process.env.KITE_API_KEY;
    const apiSecret = process.env.KITE_API_SECRET;

    if (!token || !apiKey) {
      return res.status(401).json({ ok: false, error: "Missing api_key or access_token." });
    }

    const kc = new KiteConnect({ api_key: apiKey });
    kc.setAccessToken(token);

    const funds = await kc.getMargins();
    const balance =
      funds?.equity?.available?.live_balance ??
      funds?.equity?.available?.cash ??
      funds?.equity?.net ??
      0;

    // Save the latest balance for UI
    await kv.set(key, { ...state, current_balance: balance });

    res.status(200).json({ ok: true, funds, balance });
  } catch (e) {
    res.status(500).json({ ok: false, error: e.message || String(e) });
  }
}
