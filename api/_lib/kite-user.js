// /api/_lib/kite-user.js

import crypto from "crypto";

/**
 * Exchange request_token for access_token using user's API key + secret
 */
export async function exchangeRequestTokenUser(request_token, api_key, api_secret) {
  const checksum = crypto
    .createHash("sha256")
    .update(api_key + request_token + api_secret)
    .digest("hex");

  const body = new URLSearchParams({
    api_key,
    request_token,
    checksum,
  });

  const res = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: { 
      "Content-Type": "application/x-www-form-urlencoded"
    },
    body,
  });

  const json = await res.json();

  if (!json || !json.data) {
    console.error("Invalid token exchange response:", json);
    return null;
  }

  return json.data;
}
