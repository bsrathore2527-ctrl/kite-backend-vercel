// File: /api/_lib/kite-user.js

// USER APP CREDS
const USER_API_KEY = process.env.USER_API_KEY;
const USER_API_SECRET = process.env.USER_API_SECRET;

if (!USER_API_KEY || !USER_API_SECRET) {
  console.error("⚠ USER_API_KEY or USER_API_SECRET missing!");
}

/**
 * Generate Zerodha Login URL for USER login
 *
 * VERY IMPORTANT:
 * - Use https://kite.trade/connect/login
 * - NO redirect_uri in URL (Zerodha auto-uses app redirect)
 * - state MUST be user_id
 */
export function getUserLoginUrl(user_id) {
  const state = user_id; // critical for callback

  return `https://kite.trade/connect/login?v=3&api_key=${USER_API_KEY}&state=${state}`;
}


/**
 * Exchange request_token → access_token
 *
 * Must POST to: https://api.kite.trade/session/token
 * With fields:
 * - api_key
 * - request_token
 * - checksum = SHA256(api_key + request_token + api_secret)
 */
export async function exchangeRequestTokenUser(request_token) {
  try {
    const url = "https://api.kite.trade/session/token";

    const checksumStr = USER_API_KEY + request_token + USER_API_SECRET;
    const sig = sha256(checksumStr);

    const body = new URLSearchParams({
      api_key: USER_API_KEY,
      request_token,
      checksum: sig
    });

    const res = await fetch(url, {
      method: "POST",
      headers: {
        "X-Kite-Version": "3",
        "Content-Type": "application/x-www-form-urlencoded"
      },
      body
    });

    const json = await res.json();

    if (!json || json.status === "error") {
      console.error("❌ TOKEN EXCHANGE FAILED:", json);
      return null;
    }

    return json.data || null;

  } catch (err) {
    console.error("exchangeRequestTokenUser ERROR:", err);
    return null;
  }
}


/**
 * SHA256 checksum
 */
import crypto from "crypto";
function sha256(str) {
  return crypto.createHash("sha256").update(str).digest("hex");
}
