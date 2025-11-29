// ======================================================================
// kite.js  (MULTI-USER • FINAL • PRODUCTION)
// Compatible with:
// - enforce-trades.js
// - exits.js (cancelPending, squareOffAll)
// - ticker-worker.js
// - state.js / guardian.js
// ======================================================================

import { KiteConnect } from "kiteconnect";
import { kv } from "./kv.js";

/* ---------------------------------------------------
   KV KEY HELPERS (MULTI-USER)
--------------------------------------------------- */

function key_access(userId) {
  return `kite:access_token:${userId}`;
}

function key_client(userId) {
  return `kite:client_id:${userId}`;
}

/* ---------------------------------------------------
   ACCESS TOKEN HELPERS (MULTI-USER)
--------------------------------------------------- */

export async function getAccessToken(userId) {
  return (await kv.get(key_access(userId))) || "";
}

export async function setAccessToken(userId, token) {
  await kv.set(key_access(userId), token);
  return token;
}

/* ---------------------------------------------------
   GET CLIENT ID FOR CURRENT LOGGED IN USER
   (For single-user mode, this returns your only user)
--------------------------------------------------- */
export async function getClientId() {
  return await kv.get("kite:client_id:active") || null;
}

/* ---------------------------------------------------
   STORE CLIENT ID (called during login)
--------------------------------------------------- */
async function setClientId(userId) {
  await kv.set("kite:client_id:active", userId);
  await kv.sadd("global:users", userId);
}

/* ---------------------------------------------------
   GET KITE CLIENT FOR SPECIFIC USER
   (Used by enforce-trades, squareOffAll, ticker-worker)
--------------------------------------------------- */
export async function getKiteClient(userId) {
  const apiKey = process.env.KITE_API_KEY;
  if (!apiKey) throw new Error("Missing KITE_API_KEY");

  const token = await getAccessToken(userId);
  if (!token) throw new Error("User not logged in or token missing");

  const kc = new KiteConnect({ api_key: apiKey });
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
   EXCHANGE REQUEST TOKEN (LOGIN FLOW)
--------------------------------------------------- */
export async function exchangeRequestToken(request_token) {
  const apiKey = process.env.KITE_API_KEY;
  const apiSecret = process.env.KITE_API_SECRET;

  if (!apiKey || !apiSecret)
    throw new Error("Missing KITE_API_KEY or KITE_API_SECRET");

  const kc = new KiteConnect({ api_key: apiKey });

  // exchange token with Zerodha
  const data = await kc.generateSession(request_token, apiSecret);

  // Save multi-user token
  await setAccessToken(data.user_id, data.access_token);

  // Save active user ID for backend access
  await setClientId(data.user_id);

  return data; // { user_id, access_token, public_token, ... }
}
