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

  await setAccessToken(data.access_token);

  return data;  // contains client_id etc.
}
