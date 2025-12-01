import KiteConnect from "kiteconnect";
import { kv } from "./kv";

/**
 * Create a Zerodha Kite instance for a specific user.
 * This uses:
 *   - Shared USER_API_KEY (same for all users)
 *   - User-specific access token stored at: user:<id>:token
 */
export async function createKiteInstanceForUser(user_id) {
  if (!user_id) {
    throw new Error("Missing user_id");
  }

  // Get saved token from KV
  const tokenData = await kv.get(`user:${user_id}:token`);
  if (!tokenData || !tokenData.access_token) {
    throw new Error("User Zerodha access token not found. User must login first.");
  }

  if (!process.env.USER_API_KEY) {
    throw new Error("Missing USER_API_KEY env variable.");
  }

  // Create Kite instance
  const kc = new KiteConnect({
    api_key: process.env.USER_API_KEY,
  });

  // Attach access token
  kc.setAccessToken(tokenData.access_token);

  return kc;
}
