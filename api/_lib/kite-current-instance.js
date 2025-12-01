import KiteConnect from "kiteconnect";
import { kv } from "./kv.js";

export async function createKiteInstanceForCurrentUser() {
  // Single user mode: always use the "current active session"
  const tokenData = await kv.get("kite:current:token");

  if (!tokenData || !tokenData.access_token) {
    throw new Error("No active Zerodha session. Please login again.");
  }

  if (!process.env.USER_API_KEY) {
    throw new Error("Missing USER_API_KEY env variable");
  }

  const kc = new KiteConnect({ api_key: process.env.USER_API_KEY });
  kc.setAccessToken(tokenData.access_token);

  return kc;
}
