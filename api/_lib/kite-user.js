// /api/_lib/kite-user.js

// Build Zerodha login URL
export function getUserLoginUrl(callbackRedirect) {
  const encoded = encodeURIComponent(callbackRedirect);

  return `https://kite.trade/connect/login?api_key=${process.env.USER_API_KEY}&redirect_url=${encoded}`;
}

// Manual request-token → access-token exchange (multi-user ready)
export async function exchangeRequestTokenUser(requestToken) {
  const apiKey = process.env.USER_API_KEY;
  const apiSecret = process.env.USER_API_SECRET;

  const body = new URLSearchParams({
    api_key: apiKey,
    request_token: requestToken,
    checksum: `${apiKey}${requestToken}${apiSecret}`
  });

  const response = await fetch("https://api.kite.trade/session/token", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });

  if (!response.ok) throw new Error("Exchange token failed");

  return response.json();
}
