// /api/_lib/kite-user.js

export function getUserLoginUrl(userId, callbackRedirect) {
  if (!process.env.USER_API_KEY) {
    throw new Error("USER_API_KEY missing");
  }
  if (!callbackRedirect) {
    throw new Error("No callback redirect URL provided");
  }

  const encoded = encodeURIComponent(callbackRedirect);

  // Final correct URL for kite.trade
  return `https://kite.trade/connect/login?api_key=${process.env.USER_API_KEY}&redirect_url=${encoded}`;
}
