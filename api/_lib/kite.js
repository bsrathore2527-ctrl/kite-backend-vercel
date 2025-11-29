// api/_lib/kite.js
import { KiteConnect } from "kiteconnect";
import { kv } from "./kv.js";

/* ---------------------------------------------------
   ACCESS TOKEN HELPERS
--------------------------------------------------- */

export async function getAccessToken() {
  return (await kv.get("kite:access_token")) || "";
}

export async function setAccessToken(token) {
  await kv.set("kite:access_token", token);
  return token;
}

/* ---------------------------------------------------
   KITE INSTANCE
--------------------------------------------------- */

export async function instance() {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY");

  const kc = new KiteConnect({ api_key: apiKey });
  const token = await getAccessToken();

  if (!token) throw new Error("Kite not logged in");

  kc.setAccessToken(token);
  return kc;
}

/* ---------------------------------------------------
   LOGIN URL
--------------------------------------------------- */

export function loginUrl() {
  const apiKey = process.env.KITE_API_KEY;
  const kc = new KiteConnect({ api_key: apiKey });
  return kc.getLoginURL();
}

/* ---------------------------------------------------
   EXCHANGE REQUEST TOKEN
--------------------------------------------------- */

export async function exchangeRequestToken(request_token) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!apiKey || !apiSecret)
    throw new Error("Missing KITE_API_KEY/SECRET");

  const kc = new KiteConnect({ api_key: apiKey });

  const data = await kc.generateSession(request_token, apiSecret);

  // Save access token (existing behavior)
  await setAccessToken(data.access_token);

  // NEW: Save Zerodha client_id for use across enforce.js, hub.js, etc.
  // This enables KV positions, KV tradebook, per-user MTM.
  await kv.set("kite:client_id", data.user_id);

  // NEW: Register this user in active users set (future multi-user support)
  await kv.sadd("global:users", data.user_id);

  return data;  // contains user_id, access_token, public_token, etc.
}

/* ---------------------------------------------------
   GET CLIENT ID (NEW HELPER)
--------------------------------------------------- */

export async function getClientId() {
  return await kv.get("kite:client_id");
}
