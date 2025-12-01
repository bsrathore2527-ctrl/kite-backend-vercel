import KiteConnect from "kiteconnect";
import { kv } from "./kv.js";   // <-- CORRECT PATH

export async function createKiteInstanceForUser(user_id) {
  if (!user_id) {
    throw new Error("Missing user_id");
  }

  // Fetch stored token
  const tokenData = await kv.get(`user:${user_id}:token`);
  if (!tokenData || !tokenData.access_token) {
    throw new Error("No access token found. User must login again.");
  }

  if (!process.env.USER_API_KEY) {
    throw new Error("Missing USER_API_KEY env var");
  }

  // Create Kite instance
  const kc = new KiteConnect({
    api_key: process.env.USER_API_KEY,
  });

  kc.setAccessToken(tokenData.access_token);
  return kc;
}
