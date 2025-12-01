// /api/_lib/kite-user.js
import fetch from "node-fetch";

export async function exchangeRequestTokenUser(request_token, api_key, api_secret) {
  const url =
    "https://api.kite.trade/session/token";

  const body = new URLSearchParams({
    api_key,
    request_token,
    checksum: require("crypto")
      .createHash("sha256")
      .update(api_key + request_token + api_secret)
      .digest("hex")
  });

  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  const json = await res.json();
  return json.data || null;
}
