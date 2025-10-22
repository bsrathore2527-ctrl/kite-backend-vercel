// api/_lib/kite.js
import { KiteConnect } from "kiteconnect";
import { getState, setState } from "./state.js";

/**
 * Note: KiteConnect usage depends on correct env vars:
 * KITE_API_KEY and KITE_API_SECRET
 */

export async function getAccessToken() {
  const s = await getState();
  return s?.access_token || "";
}

export async function setAccessToken(tokenObj) {
  // tokenObj can be string or object (if you want to store more)
  const s = await getState();
  const next = { ...s, access_token: typeof tokenObj === "string" ? tokenObj : tokenObj.access_token || s.access_token };
  await setState(next);
  return next;
}

export function loginUrl() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY");
  const kc = new KiteConnect({ api_key: apiKey });
  return kc.getLoginURL();
}

export async function generateSession(request_token) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;
  if (!apiKey || !apiSecret) throw new Error("Missing KITE_API_KEY/SECRET");
  const kc = new KiteConnect({ api_key: apiKey });
  const data = await kc.generateSession(request_token, apiSecret);
  // store access token
  await setAccessToken(data.access_token);
  return data;
}

export async function instance() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY");
  const kc = new KiteConnect({ api_key: apiKey });
  const token = await getAccessToken();
  if (!token) throw new Error("Kite not logged in: missing access token");
  kc.setAccessToken(token);
  return kc;
}
